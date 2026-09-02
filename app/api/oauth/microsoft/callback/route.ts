import { NextResponse } from "next/server";
import { exchangeMicrosoftCode, saveMicrosoftToken } from "@/lib/msGraphOAuth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const err = url.searchParams.get("error");
  const errDesc = url.searchParams.get("error_description") || "";
  const stateRaw = url.searchParams.get("state") || "";

  let back = "/account";
  let upn = "";
  try {
    const state = JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf-8")) as {
      upn?: string;
      back?: string;
    };
    upn = (state.upn || "").toLowerCase();
    if (state.back?.startsWith("/")) back = state.back;
  } catch { /* bad state */ }

  /* ปลายทางของการ "อนุญาตให้ทั้งองค์กร" (v2.0/adminconsent) ด้วย
     
     ปลายทางนั้นต้องเป็น redirect_uri ที่ลงทะเบียนไว้แล้วเท่านั้น จึงใช้ตัวนี้
     ร่วมกัน — แต่มันไม่ส่ง code กลับมา ส่ง admin_consent=True มาแทน ถ้าไม่ดัก
     ไว้จะไปตกที่ "missing_code" แล้วดูเหมือนล้มเหลวทั้งที่อนุมัติสำเร็จ */
  if (url.searchParams.get("admin_consent")) {
    const ok = url.searchParams.get("admin_consent") === "True" && !err;
    return NextResponse.redirect(`${url.origin}/todo/admin${ok ? "" : `?error=${encodeURIComponent(errDesc || err || "denied")}`}`);
  }

  const dest = (q: string, detail?: string) => {
    const u = new URL(`${url.origin}${back}`);
    u.searchParams.set("ms", q);
    if (detail) u.searchParams.set("ms_detail", detail.slice(0, 120));
    return NextResponse.redirect(u.toString());
  };

  if (err) {
    console.error("[ms-oauth] authorize error", err, errDesc);
    return dest(err === "access_denied" ? "denied" : "error", errDesc || err);
  }
  if (!code || !upn) return dest("error", !code ? "missing_code" : "missing_upn");

  try {
    const tok = await exchangeMicrosoftCode(code);
    if (!tok.refresh_token) {
      console.error("[ms-oauth] no refresh_token in response", Object.keys(tok));
      return dest("no_refresh");
    }
    await saveMicrosoftToken(upn, tok.refresh_token, tok.scope, upn);
    return dest("connected");
  } catch (e) {
    console.error("[ms-oauth] callback", e);
    return dest("error", String(e).slice(0, 120));
  }
}
