/**
 * Confirmation-word safety — short "ยืนยัน" / "ตกลง" / "ใช่" / "ok" may only
 * answer the question the assistant just asked (last_intent confirm_*).
 *
 * See AGENTS.md. A bare confirm once accepted a stale meeting invite because
 * the RSVP pre-pipeline ran before the command handler.
 */

/** Bare yes/confirm — no intent prefix. */
export function isShortConfirmText(text: string): boolean {
  return /^(?:ยืนยัน|ตกลง|ใช่|โอเค|ปิด|confirm|ok|okay|yes)$/i.test((text || "").trim());
}

/** Assistant is waiting on its own yes/no (confirm_complete_task, confirm_add_task, …). */
export function assistantHasOutstandingConfirm(lastIntent?: string | null): boolean {
  return String(lastIntent || "").startsWith("confirm_");
}

/**
 * Pre-pipeline handlers (RSVP / reschedule / host-edit) must step aside when
 * the user is answering the assistant's outstanding confirm question.
 */
export function shouldDeferPrePipeline(
  lastIntent: string | null | undefined,
  text: string
): boolean {
  return assistantHasOutstandingConfirm(lastIntent) && isShortConfirmText(text);
}
