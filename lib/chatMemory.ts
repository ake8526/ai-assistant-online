// Rolling chat memory: active within 30 minutes of last reply.
// - Idle > 30 min → treat as a brand-new topic (caller clears / ignores store).
// - While chatting → keep only turns from the last 30 min; older turns fold into
//   a short summary so the model still knows the thread gist.

export const CHAT_MEMORY_TTL_MS = 30 * 60 * 1000;
export const CHAT_HISTORY_MAX_TURNS = 20;
export const CHAT_SUMMARY_MAX_CHARS = 900;

export type ChatTurn = { role: string; text: string; ts: number };

export function chatMemoryExpired(lastActivityTs: number | undefined | null, now = Date.now()): boolean {
  if (!lastActivityTs) return true;
  return now - lastActivityTs > CHAT_MEMORY_TTL_MS;
}

function roleLabel(role: string): string {
  return role === "me" || role === "user" ? "ผู้ใช้" : "ผู้ช่วย";
}

/** Drop turns older than TTL and fold them into `summary`. */
export function pruneChatHistory(
  history: ChatTurn[],
  prevSummary: string | undefined,
  now = Date.now()
): { history: ChatTurn[]; summary?: string } {
  const cutoff = now - CHAT_MEMORY_TTL_MS;
  const fresh: ChatTurn[] = [];
  const stale: ChatTurn[] = [];
  for (const t of history || []) {
    const ts = typeof t.ts === "number" ? t.ts : 0;
    if (ts >= cutoff) fresh.push({ role: t.role, text: String(t.text || "").slice(0, 400), ts });
    else if (t.text?.trim()) stale.push(t);
  }

  let summary = (prevSummary || "").trim();
  if (stale.length) {
    const bit = stale
      .map((t) => `${roleLabel(t.role)}: ${String(t.text || "").trim().replace(/\s+/g, " ").slice(0, 100)}`)
      .join(" · ");
    summary = [summary, bit].filter(Boolean).join(" · ").slice(0, CHAT_SUMMARY_MAX_CHARS);
  }

  // Soft fade: keep newest turns only
  const capped = fresh.slice(-CHAT_HISTORY_MAX_TURNS);
  return { history: capped, summary: summary || undefined };
}

export function appendChatTurns(
  history: ChatTurn[],
  userText: string | undefined,
  assistantText: string | undefined,
  now = Date.now()
): ChatTurn[] {
  const next = [...history];
  if (userText?.trim()) next.push({ role: "user", text: userText.trim().slice(0, 400), ts: now });
  if (assistantText?.trim()) next.push({ role: "assistant", text: assistantText.trim().slice(0, 500), ts: now });
  return next;
}
