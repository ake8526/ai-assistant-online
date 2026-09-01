/**
 * Pure text classifiers for meeting RSVP / reschedule.
 * Kept free of DB/Graph so confirm-safety regressions can run without env.
 */

/** Attendee asking to move the meeting time (e.g. เปลี่ยนเวลาเป็นบ่าย3). */
export function isMeetingRescheduleText(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return /เปลี่ยนเวลา|เลื่อน(นัด|เวลา|ประชุม)?|ขอเลื่อน|ย้ายเวลา|เลื่อนไป|เปลี่ยนเป็น|ขอเปลี่ยน/.test(t);
}

/**
 * Free-text RSVP while a LINE invite is pending.
 *
 * Never treat bare "ยืนยัน" / "ตกลง" / "ok" as accept — those words belong to
 * whatever question the assistant asked last (see AGENTS.md / confirmSafety).
 * Buttons send specific displayText: "ยืนยันนัดนี้" / "ยืนยันเข้าร่วมนัด".
 */
export function classifyMeetingRsvpText(text: string): "accept" | "decline" | null {
  const t = (text || "").trim();
  if (!t) return null;
  if (isMeetingRescheduleText(t)) return null;
  if (
    /^(?:ยืนยันนัดนี้|ยืนยันเข้าร่วม(?:นัด)?|เข้าร่วม(?:นัด)?|ไปได้|รับนัด)$/i.test(t) ||
    /^ยืนยันเข้าร่วม/.test(t)
  ) {
    return "accept";
  }
  if (
    /ไม่สะดวก|ไปไม่ได้|ขอถอน|ติดธุระ|ขอโทษ.*(ไม่|ยกเลิก)|decline/i.test(t) ||
    /ยกเลิก(นัด|การเข้าร่วม|ให้)?/.test(t) ||
    /^\/?ยกเลิก$/.test(t)
  ) {
    return "decline";
  }
  return null;
}

/** True when text looks like RSVP (used to keep news onboarding from stealing it). */
export function isMeetingRsvpText(text: string): boolean {
  return classifyMeetingRsvpText(text) != null;
}
