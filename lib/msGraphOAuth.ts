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
  "Calendars.Read",
  "Calendars.Read.Shared",
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
    scope: GRAPH_SCOPE,
    state,
    // Azure AD allows only ONE prompt value (unlike Google).
    // "consent" forces the calendar permission screen + refresh token.
    prompt: "consent",
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

  const r = await fetch(`${AUTH_URL}/${tenant()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: data.refresh_token,
      grant_type: "refresh_token",
      scope: GRAPH_SCOPE,
    }),
  });
  if (!r.ok) {
    console.warn(`[ms-oauth] refresh failed for ${upn}:`, (await r.text()).slice(0, 200));
    return null;
  }
  const json = await r.json();
  // Persist rotated refresh token when Microsoft returns a new one
  if (json.refresh_token && json.refresh_token !== data.refresh_token) {
    try {
      await saveMicrosoftToken(upn, json.refresh_token, json.scope);
    } catch { /* ignore */ }
  }
  return json.access_token || null;
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
