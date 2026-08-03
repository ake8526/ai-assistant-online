import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { deleteMicrosoftToken, hasMicrosoftToken } from "@/lib/msGraphOAuth";
import { assertConfigured } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

/** GET — whether this user has granted Graph calendar access (delegated). */
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const linked = await hasMicrosoftToken(upn);
    return NextResponse.json({
      linked,
      note: linked
        ? "ดูตารางตามสิทธิ์ Microsoft 365 ของคุณแล้ว (เหมือน Outlook)"
        : "ยังไม่อนุญาต — จะเห็นตารางคนอื่นตามที่ 365 แชร์ให้คุณเท่านั้นหลังอนุญาต",
    });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}

/** DELETE — revoke stored delegated calendar token. */
export async function DELETE(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    await deleteMicrosoftToken(upn);
    return NextResponse.json({ ok: true, linked: false });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
