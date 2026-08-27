/**
 * The two lists people pick from most in LINE — “ชื่อนี้ตรงกันหลายคน” and
 * “เลือกเวลาเริ่ม” — rendered as a Flex card instead of a strip of numbered
 * quick-reply buttons.
 *
 * Why: a quick-reply label stops at 20 characters and the strip scrolls
 * sideways, so three of ten names were visible and the rest were behind a
 * swipe. A Flex row shows the whole name (and the mail under it) and takes the
 * tap itself. Same rows as the help menu, from lib/lineCards.ts.
 *
 * The numbers stay in front of every row on purpose: typing “1”, “1กับ2” or
 * “ทั้งหมด” is still handled in lib/commands.ts (pending_avail_pick /
 * pending_mt_pick), so the numbering here has to agree with the list those
 * paths count. That is also the fallback when a postback payload is over
 * LINE's 300-character limit — the row sends its number as a message and lands
 * in the typed-pick path rather than going dead.
 */

import type { CommandResult } from "@/lib/commands";
import { messageRow, noteRow, pickerCard, postbackRow } from "@/lib/lineCards";

export type Choice = {
  mail?: string;
  displayName?: string;
  period?: string;
  date?: string;
  event_id?: string;
  feed_id?: string;
  index?: number;
  label?: string;
  short_label?: string;
  data?: string;
  lunch?: boolean;
  mode?: string;
  task_id?: number;
  after?: string;
  before?: string;
  at?: string;
};

export type Slot = { start: string; end: string; label?: string };

/**
 * Postback payload for one person on a disambiguation list. Built in one place
 * because both the quick-reply buttons and the Flex card carry it, and a
 * mismatch would send the tap to a different day than the card shows.
 */
export function personPickData(c: Choice): string {
  if (!c.mail) return "";
  const p =
    c.mode === "busy"
      ? new URLSearchParams({ a: "personbusy", m: c.mail, p: c.period || "upcoming" })
      : new URLSearchParams({ a: "avail", m: c.mail });
  if (c.date) p.set("d", c.date);
  else if (c.mode !== "busy") p.set("p", c.period || "week");
  if (c.lunch) p.set("ln", "1");
  if (c.after) p.set("af", c.after);
  if (c.before) p.set("bf", c.before);
  if (c.at) p.set("tm", c.at);
  // Carrying the display name saves a directory lookup on tap, but a Thai name
  // URL-encodes to ~250 characters and LINE silently drops any postback over
  // 300 — which is why the numbered button for “เบสท์ ชนัญชิดา บัวน้ำจืด” never
  // appeared. When it does not fit, leave it out: handleSelection() resolves the
  // name from the mail address instead.
  const name = c.displayName && c.displayName !== c.mail ? c.displayName : "";
  if (name) {
    const withName = new URLSearchParams(p);
    withName.set("n", name);
    const s = withName.toString();
    if (s.length <= 300) return s;
  }
  return p.toString();
}

/** Postback payload for one free slot: tapping it opens the booking draft. */
export function slotPickData(s: Slot, subject: string, attendees: string[]): string {
  return new URLSearchParams({
    a: "book",
    s: s.start,
    e: s.end,
    subj: subject,
    at: attendees.join(","),
  }).toString();
}

/** Returns null when this result is not one of the two pickable lists. */
export function pickerFlexFor(res: CommandResult): { altText: string; contents: object } | null {
  if ((res.intent === "choose_person" || res.intent === "choose_mt_person") && Array.isArray(res.choices)) {
    const choices = (res.choices as Choice[]).filter((c) => c.mail);
    if (!choices.length) return null;
    const busy = choices.some((c) => c.mode === "busy");
    const rows: object[] = [];
    choices.forEach((c, i) => {
      const n = i + 1;
      const name = c.displayName || c.mail || `ตัวเลือก ${n}`;
      const data = res.intent === "choose_mt_person" ? c.data || "" : personPickData(c);
      const label = `${n}) ${name}`;
      rows.push(
        postbackRow(label, data, `เลือก ${n}) ${name}`, c.mail) || messageRow(label, String(n), c.mail)
      );
    });
    if (choices.length > 1) {
      // “ทั้งหมด” is the word the typed-pick path already accepts
      // (isSelectAllChoices); the row sends the longer “เลือกทั้งหมด” so the
      // text in the chat log says which list it answered.
      rows.push(
        messageRow(busy ? "👥 ทั้งหมด (ดูนัดทุกคน)" : "👥 ทั้งหมด (หาเวลาว่างตรงกัน)", "เลือกทั้งหมด")
      );
    }
    // No “พิมพ์เลขก็ได้” note here — the text bubble above the card already
    // carries that hint, and it is the same copy the web chat shows.
    const title = busy ? "👥 เลือกคนที่จะดูนัด" : "👥 เลือกคนที่จะดูตาราง";
    return pickerCard(title, "ชื่อนี้ตรงกันหลายคน — แตะคนที่ต้องการ", rows, `${title} — แตะคนที่ต้องการ`);
  }

  // Which meeting to summarise. Meeting titles are the longest strings this bot
  // shows anyone, and a 20-character quick-reply label cut every one of them to
  // "ประชุมประจำสัปดาห์ฝ่…" — the list was numbers with the answer hidden.
  if (res.intent === "choose_meeting" && Array.isArray(res.choices)) {
    const choices = (res.choices as Choice[]).filter((c) => c.event_id);
    if (!choices.length) return null;
    const rows: object[] = [];
    choices.forEach((c, i) => {
      const n = i + 1;
      // Choices arrive pre-formatted as "21/08/2026 14:00 — หัวข้อ · 1 ชม.".
      // Put the subject on the row and the when underneath it, so a column of
      // meetings reads as titles rather than as a column of identical dates.
      const raw = c.label || `ประชุม ${n}`;
      const cut = raw.indexOf(" — ");
      const when = cut > 0 ? raw.slice(0, cut).trim() : "";
      const subject = cut > 0 ? raw.slice(cut + 3).trim() : raw;
      const label = `${n}) ${subject}`;
      const data = new URLSearchParams({ a: "sum", id: c.event_id as string }).toString();
      rows.push(
        postbackRow(label, data, `สรุป ${n}) ${subject}`, when || c.short_label) ||
          messageRow(label, String(n), when || c.short_label)
      );
    });
    rows.push(noteRow("สรุปได้เฉพาะประชุมที่เปิดบันทึกและถอดเสียงไว้ตอนประชุมครับ"));
    return pickerCard("📝 เลือกประชุมที่จะสรุป", "แตะประชุมที่ต้องการ", rows, "เลือกประชุมที่จะสรุป");
  }

  // Which task to close. The rows carry a=doneask, not a=done: the card asks
  // before it finishes anybody's work.
  if (res.intent === "choose_task" && Array.isArray(res.choices)) {
    const choices = (res.choices as Choice[]).filter((c) => c.task_id);
    if (!choices.length) return null;
    const rows: object[] = [];
    choices.forEach((c, i) => {
      const n = i + 1;
      const label = `${n}) ${c.label || `งาน ${n}`}`;
      rows.push(
        postbackRow(label, `a=doneask&t=${c.task_id}`, `ปิดงาน ${label}`) || messageRow(label, `ปิดงาน ${n}`)
      );
    });
    rows.push(noteRow("แตะที่งานแล้วจะถามยืนยันก่อนปิดครับ"));
    return pickerCard("✅ เลือกงานที่จะปิด", "แตะงานที่ทำเสร็จแล้ว", rows, "เลือกงานที่จะปิด");
  }

  if (Array.isArray(res.slots) && res.slots.length && (res.intent === "availability" || res.intent === "choose_slot")) {
    const meeting = (res.meeting as { attendees?: string[]; subject?: string; duration?: number }) || {};
    const attendees = meeting.attendees || (res.person?.mail ? [res.person.mail] : []);
    const subject = meeting.subject || "ประชุม";
    const duration = meeting.duration || 30;
    const rows: object[] = [];
    (res.slots as Slot[]).forEach((s, i) => {
      const n = i + 1;
      const label = `${n}) ${s.label || `${s.start}-${s.end}`}`;
      rows.push(
        postbackRow(label, slotPickData(s, subject, attendees), `จอง ${label}`) ||
          messageRow(label, String(n))
      );
    });
    // “ขอดูเพิ่มเติม” and friends: rows here instead of chips, so everything
    // tappable for this reply sits in one place.
    if (Array.isArray(res.suggestions)) {
      for (const s of res.suggestions.slice(0, 2)) {
        if (!s?.label || !s?.text) continue;
        rows.push(messageRow(s.label, s.text));
      }
    }
    const custom = new URLSearchParams({
      a: "bookcustom",
      subj: subject,
      at: attendees.join(","),
      dur: String(duration),
    }).toString();
    const customRow = postbackRow("✏️ กำหนดเวลาเอง", custom, "กำหนดเวลาเอง");
    if (customRow) rows.push(customRow);
    // Tapping a time opens the draft card; nothing reaches Outlook until that
    // card is confirmed. Say so, so a tap does not read as booking.
    rows.push(noteRow("แตะเวลาแล้วยังมีหน้าตรวจสอบก่อนลง Outlook อีกครั้ง"));
    const title = `🕐 เลือกเวลาเริ่ม (${duration} นาที)`;
    return pickerCard(title, "แตะช่วงเวลาที่ต้องการ", rows, `${title} — แตะช่วงเวลาที่ต้องการ`);
  }

  return null;
}
