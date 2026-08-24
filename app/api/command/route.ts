import { NextResponse, after } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { handleCommand } from "@/lib/commands";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { assertConfigured } from "@/lib/supabaseServer";
import { runWithTrace, trace } from "@/lib/trace";
import { logChatTurn } from "@/lib/store";

export const maxDuration = 60;

// POST { text, context?, graphToken? } → run command as the signed-in user.
// graphToken (or stored Microsoft refresh) makes calendar reads follow M365 rights.
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    const body = await req.json();
    const text = String(body.text || "").trim();
    if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

    const live = typeof body.graphToken === "string" ? body.graphToken : "";
    const { result, asUser } = await runWithTrace({ upn, channel: "web" }, async () => {
      trace("receive", "ข้อความเข้าจากเว็บ");
      const out = await withDelegatedGraph(
        upn,
        () => handleCommand(upn, text, body.context || undefined),
        live
      );
      trace("reply", `ตอบกลับ (${out.result.intent})`);
      return out;
    });

    after(async () => {
      await logChatTurn({
        session_id: upn,
        user_upn: upn,
        channel: "web",
        role: "user",
        content: text,
      });
      if (result.reply?.trim()) {
        await logChatTurn({
          session_id: upn,
          user_upn: upn,
          channel: "web",
          role: "assistant",
          content: result.reply,
          metadata: { intent: result.intent },
        });
      }
    });

    return NextResponse.json({ ...result, calendarAsUser: asUser });
  } catch (e) {
    console.error("Command route error:", e);
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
