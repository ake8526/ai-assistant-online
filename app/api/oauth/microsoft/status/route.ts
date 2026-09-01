import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { deleteMicrosoftToken, hasMicrosoftToken } from "@/lib/msGraphOAuth";
import { assertConfigured } from "@/lib/supabaseServer";
import { graphGet } from "@/lib/graph";

export const dynamic = "force-dynamic";

/** GET — whether this user has granted Graph calendar access (delegated). */
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const linked = await hasMicrosoftToken(upn);

    /* บัญชีที่ไม่มีกล่องจดหมาย (ไม่ได้รับ License Microsoft 365) ล็อกอินเข้ามาได้
       แต่ส่งคำเชิญประชุมให้ใครไม่ได้เลย — ต้องบอกตั้งแต่ต้นว่าให้ไปขอ License
       จาก IT ไม่ใช่ปล่อยให้ไปเจอตอนกดส่งนัดแล้วพัง
       ถามไม่ได้ (Graph ล่ม/สิทธิ์ไม่พอ) ให้เป็น null = ไม่รู้ ดีกว่าเตือนผิด ๆ */
    let mailbox: boolean | null = null;
    try {
      const me = (await graphGet(`/users/${encodeURIComponent(upn)}`, {
        $select: "mail,userPrincipalName",
      })) as { mail?: string | null };
      mailbox = !!(me?.mail || "").trim();
    } catch {
      mailbox = null;
    }

    return NextResponse.json({
      linked,
      mailbox,
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
