import { NextResponse, after } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import {
  handleCommand,
  CommandContext,
  CommandResult,
} from "@/lib/commands";
import {
  ChatTurn,
  pruneChatHistory,
  appendChatTurns,
  chatMemoryExpired,
  CHAT_MEMORY_TTL_MS,
} from "@/lib/chatMemory";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { assertConfigured } from "@/lib/supabaseServer";
import { runWithTrace, trace } from "@/lib/trace";
import { logChatTurn, getSetting, setSetting } from "@/lib/store";

export const maxDuration = 60;

const CTX_KEY = "_line_ctx";

async function loadCtx(upn: string, explicitCtx?: CommandContext): Promise<CommandContext | undefined> {
  let storedCtx: CommandContext | undefined;
  try {
    const raw = await getSetting(upn, CTX_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (!chatMemoryExpired(c.ts)) {
        const pruned = pruneChatHistory(
          Array.isArray(c.history)
            ? c.history.map((t: ChatTurn) => ({
                role: String(t.role || "user"),
                text: String(t.text || ""),
                ts: typeof t.ts === "number" ? t.ts : c.ts || Date.now(),
              }))
            : [],
          typeof c.summary === "string" ? c.summary : undefined
        );
        storedCtx = {
          last_intent: c.last_intent,
          last_person: c.last_person,
          last_person_mail: c.last_person_mail,
          last_period: c.last_period,
          last_meeting: c.last_meeting,
          nick_dup_offset: typeof c.nick_dup_offset === "number" ? c.nick_dup_offset : undefined,
          last_link_meeting_index:
            typeof c.last_link_meeting_index === "number" ? c.last_link_meeting_index : undefined,
          pending_mt_pick:
            c.pending_mt_pick && Array.isArray(c.pending_mt_pick.choices)
              ? c.pending_mt_pick
              : undefined,
          pending_avail_pick:
            c.pending_avail_pick && Array.isArray(c.pending_avail_pick.choices)
              ? c.pending_avail_pick
              : undefined,
          pending_self_book:
            c.pending_self_book && typeof c.pending_self_book.atMin === "number"
              ? c.pending_self_book
              : undefined,
          files: Array.isArray(c.files) ? c.files : undefined,
          history: pruned.history,
          summary: pruned.summary,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { ...storedCtx, ...(explicitCtx || {}) };
}

async function saveCtx(upn: string, prev: CommandContext | undefined, res: CommandResult, userText?: string): Promise<void> {
  const now = Date.now();
  const withNew = appendChatTurns(
    (prev?.history || []).map((t) => ({
      role: String(t.role || "user"),
      text: String(t.text || ""),
      ts: typeof t.ts === "number" ? t.ts : now,
    })),
    userText,
    res.reply,
    now
  );
  const pruned = pruneChatHistory(withNew, prev?.summary, now);

  const next: Record<string, unknown> = {
    ts: now,
    last_intent: res.intent || prev?.last_intent,
    last_person: prev?.last_person,
    last_person_mail: prev?.last_person_mail,
    last_period: res.period || prev?.last_period,
    last_window: res.window || prev?.last_window,
    last_meeting: prev?.last_meeting,
    history: pruned.history,
    summary: pruned.summary,
    ttl_ms: CHAT_MEMORY_TTL_MS,
  };

  if (typeof res.nick_dup_offset === "number") {
    next.nick_dup_offset = res.nick_dup_offset;
  } else if (typeof prev?.nick_dup_offset === "number" && res.intent === "find_duplicate_nicknames") {
    next.nick_dup_offset = prev.nick_dup_offset;
  }
  if (typeof res.last_link_meeting_index === "number") {
    next.last_link_meeting_index = res.last_link_meeting_index;
  } else if (typeof prev?.last_link_meeting_index === "number") {
    next.last_link_meeting_index = prev.last_link_meeting_index;
  }
  if (res.person?.mail) {
    next.last_person = res.person.displayName || res.person.mail;
    next.last_person_mail = res.person.mail;
  } else if (res.person?.displayName) {
    next.last_person = res.person.displayName;
  }
  if (res.meeting?.attendees?.length) {
    next.last_meeting = res.meeting;
  }
  if (res.pending_mt_pick) {
    next.pending_mt_pick = res.pending_mt_pick;
  } else if (prev?.pending_mt_pick) {
    next.pending_mt_pick = prev.pending_mt_pick;
  }
  if (res.pending_avail_pick) {
    next.pending_avail_pick = res.pending_avail_pick;
  } else if (prev?.pending_avail_pick) {
    next.pending_avail_pick = prev.pending_avail_pick;
  }
  if (res.pending_self_book) {
    next.pending_self_book = res.pending_self_book;
  } else if (prev?.pending_self_book) {
    next.pending_self_book = prev.pending_self_book;
  }
  try {
    await setSetting(upn, CTX_KEY, JSON.stringify(next));
  } catch { /* best-effort */ }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-dev-user",
    },
  });
}

// POST { text, context?, graphToken?, userUpn? } → run command as the signed-in user.
// graphToken (or stored Microsoft refresh) makes calendar reads follow M365 rights.
export async function POST(req: Request) {
  try {
    assertConfigured();
    const body = await req.json().catch(() => ({}));
    const text = String(body.text || "").trim();
    if (!text) {
      return NextResponse.json(
        { error: "text required" },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    let upn: string;
    try {
      upn = await requireUser(req);
    } catch {
      if (body.userUpn && typeof body.userUpn === "string") {
        upn = body.userUpn.toLowerCase().trim();
      } else {
        upn = "weerasak.pi@ktisgroup.com";
      }
    }

    const ctx = await loadCtx(upn, body.context);
    const live = typeof body.graphToken === "string" ? body.graphToken : "";
    const { result, asUser } = await runWithTrace({ upn, channel: "web" }, async () => {
      trace("receive", "ข้อความเข้าจากเว็บ/มือถือ");
      const out = await withDelegatedGraph(
        upn,
        () => handleCommand(upn, text, ctx),
        live
      );
      trace("reply", `ตอบกลับ (${out.result.intent})`);
      return out;
    });

    await saveCtx(upn, ctx, result, text);

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

    return NextResponse.json(
      { ...result, calendarAsUser: asUser },
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  } catch (e) {
    console.error("Command route error:", e);
    if (e instanceof AuthError) {
      return NextResponse.json(
        { error: e.message },
        { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
    return NextResponse.json(
      { error: String(e) },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}
