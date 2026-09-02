// Microsoft Graph delegated OAuth (auth-code) — stores refresh tokens so LINE
// and server jobs can call Graph as the user and honour Outlook sharing rules.
import { runWithUserGraphToken } from "@/lib/graphAuth";
import { admin } from "@/lib/supabaseServer";

const AUTH_URL = "https://login.microsoftonline.com";
const GRAPH_SCOPE = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "People.Read",
  "Calendars.Read",
  "Calendars.ReadWrite",
].join(" ");
/**
 * ชุดที่ขอเพิ่ม Tasks.ReadWrite สำหรับซิงค์งานเข้า Microsoft To Do
 *
 * To Do ไม่มีสิทธิ์แบบ app-only เลย มีแต่ delegated — จะเขียน To Do ของใครได้
 * ต้องให้เจ้าตัวกดอนุญาตเองแล้วเก็บ refresh token ของเขาไว้
 *
 * ต้องลองชุดนี้ก่อนแล้วค่อยไล่ถอยลงไปชุดเดิม ไม่ใช่เอา Tasks ไปยัดใน
 * GRAPH_SCOPE ตรง ๆ — คนที่ยังไม่ได้อนุญาต To Do จะ refresh ไม่ผ่าน แล้วตกไป
 * ชุด calendar ที่ไม่มี People.Read ทำให้เสียความสามารถที่เคยมีไปเงียบ ๆ
 */
const GRAPH_SCOPE_TASKS = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "People.Read",
  "Calendars.Read",
  "Calendars.ReadWrite",
  "Tasks.ReadWrite",
].join(" ");

/** Fallback when stored token predates People.Read — keep calendar working. */
const GRAPH_SCOPE_CALENDAR = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "Calendars.Read",
  "Calendars.ReadWrite",
].join(" ");

function tenant(): string {
  return process.env.TENANT_ID || process.env.NEXT_PUBLIC_AZURE_TENANT_ID || "common";
}

function clientId(): string {
  return process.env.GRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_AZURE_CLIENT_ID || "";
}

function clientSecret(): string {
  return process.env.GRAPH_CLIENT_SECRET || "";
}

export function microsoftRedirectUri(): string {
  const base = (process.env.NEXT_PUBLIC_APP_BASE_URL || "").replace(/\/$/, "");
  return process.env.MICROSOFT_OAUTH_REDIRECT || `${base}/api/oauth/microsoft/callback`;
}

export function isMicrosoftOAuthConfigured(): boolean {
  return !!(clientId() && clientSecret() && microsoftRedirectUri());
}

export function buildMicrosoftAuthUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: microsoftRedirectUri(),
    response_mode: "query",
    scope: GRAPH_SCOPE_TASKS,
    state,
    // Do not force consent every time; with tenant-wide admin consent this can
    // still bounce normal users to "need admin approval" in strict tenants.
    prompt: "select_account",
  });
  return `${AUTH_URL}/${tenant()}/oauth2/v2.0/authorize?${p.toString()}`;
}

export async function exchangeMicrosoftCode(code: string): Promise<{
  refresh_token?: string;
  access_token?: string;
  scope?: string;
}> {
  const r = await fetch(`${AUTH_URL}/${tenant()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      redirect_uri: microsoftRedirectUri(),
      grant_type: "authorization_code",
      scope: GRAPH_SCOPE,
    }),
  });
  if (!r.ok) throw new Error(`microsoft token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function saveMicrosoftToken(
  upn: string,
  refresh: string,
  scope?: string,
  accountEmail?: string
): Promise<void> {
  const base = {
    owner_upn: upn.toLowerCase(),
    provider: "microsoft",
    refresh_token: refresh,
    scope: scope || GRAPH_SCOPE,
    updated_at: new Date().toISOString(),
  };

  // Prefer identity columns when migration is applied; fall back if missing.
  const full = { ...base, account_email: accountEmail || upn };
  let { error } = await admin.from("oauth_tokens").upsert(full, { onConflict: "owner_upn,provider" });
  if (error && /account_email|account_name|account_channel|column/i.test(error.message)) {
    ({ error } = await admin.from("oauth_tokens").upsert(base, { onConflict: "owner_upn,provider" }));
  }
  if (error) throw new Error(`saveMicrosoftToken: ${error.message}`);
}

export async function hasMicrosoftToken(upn: string): Promise<boolean> {
  const { data } = await admin
    .from("oauth_tokens")
    .select("refresh_token")
    .eq("owner_upn", upn.toLowerCase())
    .eq("provider", "microsoft")
    .maybeSingle();
  return !!data?.refresh_token;
}

export async function deleteMicrosoftToken(upn: string): Promise<void> {
  await admin.from("oauth_tokens").delete().eq("owner_upn", upn.toLowerCase()).eq("provider", "microsoft");
}

/** Mint a Graph access token from the stored refresh token (delegated). */
export async function getDelegatedGraphToken(upn: string): Promise<string | null> {
  const { data } = await admin
    .from("oauth_tokens")
    .select("refresh_token")
    .eq("owner_upn", upn.toLowerCase())
    .eq("provider", "microsoft")
    .maybeSingle();
  if (!data?.refresh_token) return null;

  const tryRefresh = async (scope: string): Promise<{ access?: string; refresh?: string; scope?: string } | null> => {
    const r = await fetch(`${AUTH_URL}/${tenant()}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        refresh_token: data.refresh_token,
        grant_type: "refresh_token",
        scope,
      }),
    });
    if (!r.ok) {
      console.warn(`[ms-oauth] refresh failed for ${upn} (${scope.split(" ").length} scopes):`, (await r.text()).slice(0, 200));
      return null;
    }
    const json = await r.json();
    return { access: json.access_token, refresh: json.refresh_token, scope: json.scope };
  };

  // ไล่จากชุดกว้างสุดลงไป — ได้เท่าที่เจ้าตัวเคยอนุญาตไว้จริง
  let tok = await tryRefresh(GRAPH_SCOPE_TASKS);
  if (!tok?.access) tok = await tryRefresh(GRAPH_SCOPE);
  if (!tok?.access) tok = await tryRefresh(GRAPH_SCOPE_CALENDAR);
  if (!tok?.access) return null;

  if (tok.refresh && tok.refresh !== data.refresh_token) {
    try {
      await saveMicrosoftToken(upn, tok.refresh, tok.scope);
    } catch { /* ignore */ }
  }
  return tok.access;
}

/**
 * ยืนยันกับ Entra ว่าตอนนี้ได้สิทธิ์ To Do แล้วหรือยัง แล้วอัปเดต scope ที่เก็บไว้
 *
 * scope ในตารางคือของ ณ ตอนที่เจ้าตัวกดอนุญาตครั้งล่าสุด ถ้าแอดมินมา grant
 * admin consent ให้ทั้งองค์กรทีหลัง คนที่เคยเชื่อมไว้แล้วจะได้สิทธิ์เพิ่มทันที
 * โดยไม่ต้องกดอะไรอีก — แต่ค่าที่เก็บไว้ยังเป็นของเก่า ถ้าเชื่อค่าเก่าอย่างเดียว
 * ระบบจะบอกทุกคนว่า "ยังไม่ได้อนุญาต" ตลอดไป ทั้งที่อนุญาตแล้ว
 *
 * ขอ token ด้วย scope ชุดที่มี Tasks แล้วดูว่า Entra คืนอะไรกลับมาจริง
 */
async function probeTasksScope(upn: string, refresh: string): Promise<boolean> {
  const r = await fetch(`${AUTH_URL}/${tenant()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refresh,
      grant_type: "refresh_token",
      scope: GRAPH_SCOPE_TASKS,
    }),
  });
  if (!r.ok) return false;
  const json = (await r.json()) as { scope?: string; refresh_token?: string };

  /* บันทึกสิ่งที่ Entra คืนมาเสมอ ไม่ใช่เฉพาะตอนได้ Tasks — Entra หมุน refresh
     token ใหม่ทุกครั้งที่แลก ถ้าไม่เก็บใบใหม่ไว้ก็เสี่ยงถือใบที่ถูกยกเลิกไปแล้ว
     แล้วผู้ใช้หลุดทั้งปฏิทินเพราะการเช็คสิทธิ์ To Do เฉย ๆ */
  const patch: Record<string, string> = { updated_at: new Date().toISOString() };
  if (json.scope) patch.scope = json.scope;
  if (json.refresh_token && json.refresh_token !== refresh) patch.refresh_token = json.refresh_token;
  if (Object.keys(patch).length > 1) {
    await admin
      .from("oauth_tokens")
      .update(patch)
      .eq("owner_upn", upn.toLowerCase())
      .eq("provider", "microsoft");
  }
  return /Tasks\.ReadWrite/i.test(json.scope || "");
}

/** เจ้าตัวอนุญาต To Do ไว้แล้วหรือยัง — อ่าน scope ที่บันทึกไว้ก่อน แล้วค่อยถาม Entra */
export async function hasTasksConsent(upn: string): Promise<boolean> {
  const { data } = await admin
    .from("oauth_tokens")
    .select("scope,refresh_token")
    .eq("owner_upn", upn.toLowerCase())
    .eq("provider", "microsoft")
    .maybeSingle();
  if (!data?.refresh_token) return false;
  if (/Tasks\.ReadWrite/i.test(data.scope || "")) return true;
  try {
    return await probeTasksScope(upn, data.refresh_token);
  } catch {
    return false;
  }
}

export function calendarConsentNeededMessage(): string {
  return (
    "เพื่อดูตารางตามสิทธิ์ Microsoft 365 ของคุณ (เหมือนใน Outlook) " +
    "กรุณาอนุญาตปฏิทินก่อนที่หน้าบัญชี: " +
    `${(process.env.NEXT_PUBLIC_APP_BASE_URL || "").replace(/\/$/, "")}/account`
  );
}

/** Run Graph calls as the user: optional live token, else refresh from oauth_tokens. */
export async function withDelegatedGraph<T>(
  upn: string,
  fn: () => Promise<T>,
  liveToken?: string
): Promise<{ result: T; asUser: boolean }> {
  let token = (liveToken || "").trim();
  if (!token) token = (await getDelegatedGraphToken(upn)) || "";
  if (!token) return { result: await fn(), asUser: false };
  const result = await runWithUserGraphToken(token, fn);
  return { result, asUser: true };
}
