import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { deleteMicrosoftToken } from "@/lib/msGraphOAuth";
import { loadBlocked, setBlocked, type Channel } from "@/lib/blocked";
import { isRootAdmin, loadRoles, permsOf } from "@/lib/roles";

/**
 * ใครเข้ามาทางไหน อนุญาตอะไรไว้ และระงับใครได้
 *
 * ก่อนหน้านี้ข้อมูลนี้กระจายอยู่สามตาราง (line_links, oauth_tokens, settings)
 * ไม่มีที่ไหนตอบได้ในหน้าเดียวว่า "คนนี้ผูกไลน์แล้วหรือยัง ให้สิทธิ์อะไรไว้"
 * และไม่มีทางระงับการใช้งานของใครเลยนอกจากลบแถวด้วยมือ ซึ่งเขาผูกกลับมาเองได้
 *
 * รายชื่อรวมจากทุกร่องรอยที่มี ไม่ใช่แค่คนที่ผูกไลน์ — คนที่เข้าเว็บแล้วยังไม่ผูก
 * ไลน์ต้องเห็นด้วย เพราะนั่นคือกลุ่มที่ตกค้างครึ่งทาง
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = { owner_upn?: string; upn?: string; key?: string; value?: string };

/* ป้ายสิทธิ์แบบที่คนอ่านรู้เรื่อง
   
   ปฏิทินต้องเช็คตัวเขียนก่อนแล้วหยุด ไม่งั้นได้สองป้าย "ปฏิทิน (อ่าน/เขียน)"
   กับ "ปฏิทิน (อ่าน)" ติดกัน เพราะ scope จริงมีทั้งสองค่า */
function scopeLabels(scope: string): string[] {
  const out: string[] = [];
  if (/Calendars\.ReadWrite/i.test(scope)) out.push("ปฏิทิน (อ่าน/เขียน)");
  else if (/Calendars\.Read/i.test(scope)) out.push("ปฏิทิน (อ่าน)");
  if (/Tasks\.ReadWrite/i.test(scope)) out.push("Microsoft To Do");
  if (/Files\.Read/i.test(scope)) out.push("ไฟล์ OneDrive");
  if (/People\.Read/i.test(scope)) out.push("รายชื่อคนในองค์กร");
  return out;
}

export async function GET(req: Request) {
  const gate = await guard(req, "admin");
  if (!gate.ok) return gate.response;
  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  const [links, tokens, settings, roles, blocked] = await Promise.all([
    admin.from("line_links").select("upn,line_user_id,display_name,linked_at"),
    admin.from("oauth_tokens").select("owner_upn,scope,updated_at").eq("provider", "microsoft"),
    admin
      .from("settings")
      .select("owner_upn,key,value")
      .in("key", ["todo_sync", "push_tokens", "onboarding", "work_start", "work_days"]),
    loadRoles(),
    loadBlocked(true),
  ]);

  const linkRows = (links.data || []) as {
    upn: string;
    line_user_id: string;
    display_name: string | null;
    linked_at: string | null;
  }[];
  const tokRows = (tokens.data || []) as {
    owner_upn: string;
    scope: string | null;
    updated_at: string | null;
  }[];
  const setRows = (settings.data || []) as Row[];

  const setOf = (upn: string, key: string) =>
    setRows.find((s) => String(s.owner_upn).toLowerCase() === upn && s.key === key)?.value || "";

  const people = new Set<string>();
  linkRows.forEach((r) => people.add(String(r.upn).toLowerCase()));
  tokRows.forEach((r) => people.add(String(r.owner_upn).toLowerCase()));
  setRows.forEach((r) => {
    const u = String(r.owner_upn || "").toLowerCase();
    if (u && !u.startsWith("_")) people.add(u);
  });
  Object.keys(roles).forEach((u) => people.add(u.toLowerCase()));

  const users = await Promise.all(
    [...people].sort().map(async (upn) => {
      const link = linkRows.find((r) => String(r.upn).toLowerCase() === upn);
      const tok = tokRows.find((r) => String(r.owner_upn).toLowerCase() === upn);
      const scope = tok?.scope || "";
      let devices = 0;
      try {
        const arr = JSON.parse(setOf(upn, "push_tokens") || "[]");
        devices = Array.isArray(arr) ? arr.length : 0;
      } catch {
        devices = 0;
      }
      return {
        upn,
        line: link
          ? {
              name: link.display_name || "",
              at: link.linked_at,
              id: `${String(link.line_user_id || "").slice(0, 6)}…`,
            }
          : null,
        ms: tok ? { at: tok.updated_at, scopes: scopeLabels(scope) } : null,
        todoSync: setOf(upn, "todo_sync") === "on",
        devices,
        /* ตั้งค่าเวลาทำงานหรือผ่านหน้าแนะนำการใช้งานแล้วหรือยัง = ร่องรอยว่าเคย
           เข้าหน้าเว็บและตั้งค่าจริง ไม่ใช่แค่ล็อกอินผ่าน ๆ
           (คีย์จริงคือ work_start / work_days ตาม app/api/settings) */
        setUp: !!setOf(upn, "work_start") || !!setOf(upn, "work_days") || !!setOf(upn, "onboarding"),
        perms: await permsOf(upn),
        root: isRootAdmin(upn),
        blocked: { line: !!blocked[upn]?.line, web: !!blocked[upn]?.web, at: blocked[upn]?.at || null, by: blocked[upn]?.by || null },
      };
    })
  );

  return NextResponse.json({ perms: gate.perms, me: gate.upn, users });
}

export async function POST(req: Request) {
  const gate = await guard(req, "admin");
  if (!gate.ok) return gate.response;
  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  let body: { action?: string; upn?: string; channel?: Channel; on?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const upn = (body.upn || "").trim().toLowerCase();
  if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });

  try {
    if (body.action === "block") {
      const channel: Channel = body.channel === "web" ? "web" : "line";
      const res = await setBlocked(upn, channel, !!body.on, gate.upn);
      if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 400 });
      console.warn(`[users] ${gate.upn} ${body.on ? "ระงับ" : "ปลดระงับ"} ${channel} ของ ${upn}`);
      return NextResponse.json({ ok: true });
    }

    /* ยกเลิกการผูกไลน์ — ลบแถวใน line_links เท่านั้น ไม่ระงับ เจ้าตัวผูกกลับมาได้
       ใช้กับกรณีเปลี่ยนบัญชีไลน์ ไม่ใช่กรณีต้องการปิดการใช้งาน (นั่นคือ block) */
    if (body.action === "unlink_line") {
      const { error } = await admin.from("line_links").delete().eq("upn", upn);
      if (error) throw new Error(error.message);
      console.warn(`[users] ${gate.upn} ยกเลิกการผูกไลน์ของ ${upn}`);
      return NextResponse.json({ ok: true });
    }

    /* ถอนสิทธิ์ Microsoft ที่เก็บไว้ฝั่งเรา — ไม่ได้ถอน consent ที่ Entra
       เจ้าตัวล็อกอินใหม่ก็ได้ token กลับมา (และตอนนี้ไม่เจอหน้าขออนุญาตแล้ว
       เพราะแอดมินอนุมัติทั้งองค์กรไว้) จะตัดขาดจริงต้องใช้ block */
    if (body.action === "revoke_ms") {
      await deleteMicrosoftToken(upn);
      console.warn(`[users] ${gate.upn} ลบสิทธิ์ Microsoft ที่เก็บไว้ของ ${upn}`);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}
