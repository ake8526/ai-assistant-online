// Find common free slots + free/busy ranges — ported from morning_brief/scheduling.py.
// availabilityView: one char per interval: '0'=free, '1'=tentative, '2'=busy,
// '3'=out-of-office, '4'=working-elsewhere. A slot is bookable only if everyone is '0'.
import { getEventsRange, getSchedule } from "@/lib/graph";
import { addDays, addMinutes, fmtDate, fmtDateTime, fmtDayHeader, fmtSlotRange, fmtTime, nowWall, parseWall, startOfDay, endOfDay, wallIso } from "@/lib/time";

const INTERVAL = 30; // minutes per availability slot

const WORK_START_HOUR = Number(process.env.WORK_START_HOUR || 9);
const WORK_END_HOUR = Number(process.env.WORK_END_HOUR || 17);
const SCHEDULE_DAYS_AHEAD = Number(process.env.SCHEDULE_DAYS_AHEAD || 7);

/** Default lunch break to skip when suggesting free times (unless user asks). */
export const LUNCH_START_MIN = Number(process.env.LUNCH_START_MIN || 12 * 60); // 12:00
export const LUNCH_END_MIN = Number(process.env.LUNCH_END_MIN || 13 * 60); // 13:00

export type Slot = { start: string; end: string; label: string };
export type BusyMap = Record<string, { start?: string; end?: string; subject: string; status?: string }[]>;

function overlapsLunch(startMin: number, endMin: number): boolean {
  return startMin < LUNCH_END_MIN && endMin > LUNCH_START_MIN;
}

/** True when the user explicitly wants noon / lunch included. */
export function wantsLunchIncluded(text: string): boolean {
  return /พักเที่ยง|ช่วงเที่ยง|ตอนเที่ยง|เวลาเที่ยง|เที่ยงวัน|มื้อเที่ยง|lunch|12\s*[:.]?\s*00|12\s*โมง|บ่าย\s*โมง/.test(
    (text || "").toLowerCase()
  );
}

function searchWindow(
  override?: { start: Date; end: Date },
  opts?: { exactStart?: Date; durationMin?: number }
): { start: Date; end: Date } {
  const durationMin = opts?.durationMin ?? 30;
  if (override) {
    const now = nowWall();
    let start = override.start;
    let end = override.end;
    const exact = opts?.exactStart;
    // Exact clock time on a named day (วันนี้/พรุ่งนี้) — stay on that day; don't roll to tomorrow.
    if (exact && exact.getTime() <= override.end.getTime()) {
      const dayEnd = endOfDay(override.start);
      // Align search start to the exact bucket (or "now" if exact already passed a bit)
      const bucket = new Date(exact);
      bucket.setUTCMinutes(Math.floor(bucket.getUTCMinutes() / INTERVAL) * INTERVAL, 0, 0);
      if (bucket.getTime() >= now.getTime() - 90 * 60_000) {
        start = startOfDay(override.start);
        end = dayEnd.getTime() > override.end.getTime() ? dayEnd : override.end;
        return { start, end };
      }
    }
    // If the window includes "now", don't offer slots in the past.
    if (start < now) {
      const rounded = new Date(now);
      rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / INTERVAL) * INTERVAL, 0, 0);
      // Next bookable bucket (at least one interval ahead)
      start = addMinutes(rounded, INTERVAL);
      if (start < now) start = addMinutes(start, INTERVAL);
    }
    // Explicit day (วันนี้ / พรุ่งนี้ / วันที่…) — never peek into other days.
    // (Old peek-ahead made replies say “วันนี้” while listing next Monday’s slots.)
    if (start > end) {
      // Past the end of the requested day (e.g. late evening) → empty search range
      start = end;
    }
    return { start, end };
  }
  const now = nowWall();
  const rounded = new Date(now);
  rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / INTERVAL) * INTERVAL, 0, 0);
  let start = addMinutes(rounded, INTERVAL);
  if (start < now) start = addMinutes(start, INTERVAL);
  return { start, end: addDays(startOfDay(now), SCHEDULE_DAYS_AHEAD) };
}

/** Build a wall-clock Date on the same calendar day as `day` at minute-of-day. */
function atMinuteOfDay(day: Date, minOfDay: number): Date {
  const d = new Date(day);
  d.setUTCHours(Math.floor(minOfDay / 60), minOfDay % 60, 0, 0);
  return d;
}

/** True when every INTERVAL bucket covering [start, end) is free ('0'). */
function rangeIsFree(view: string, windowStart: Date, rangeStart: Date, rangeEnd: Date): boolean {
  if (rangeEnd <= rangeStart) return false;
  const startIdx = Math.floor((rangeStart.getTime() - windowStart.getTime()) / (INTERVAL * 60_000));
  const endIdx = Math.ceil((rangeEnd.getTime() - windowStart.getTime()) / (INTERVAL * 60_000));
  if (startIdx < 0 || endIdx > view.length) return false;
  for (let i = startIdx; i < endIdx; i++) {
    if (view[i] !== "0") return false;
  }
  return true;
}

export async function findCommonSlots(
  organizerUpn: string,
  attendeeEmails: string[],
  durationMin: number,
  maxSlots = 5,
  window?: { start: Date; end: Date },
  opts?: {
    afterMin?: number | null;
    beforeMin?: number | null;
    /** Exact meeting start (minute-of-day). Prefer this over a tight after/before band. */
    atMin?: number | null;
    allStarts?: boolean;
    workEndHour?: number;
    /** When false (default), skip 12:00–13:00. */
    includeLunch?: boolean;
    /**
     * Allow Sat/Sun. Default: true when an explicit day window is set (e.g. พรุ่งนี้ = เสาร์),
     * false for open week scans (weekdays only).
     */
    includeWeekend?: boolean;
  }
): Promise<{ slots: Slot[]; busy: BusyMap; ranges: Slot[] }> {
  const atMin = opts?.atMin ?? null;
  const exactStart =
    atMin != null && window
      ? atMinuteOfDay(window.start, atMin)
      : undefined;
  const { start, end } = searchWindow(window, {
    exactStart: exactStart || undefined,
    durationMin,
  });
  const schedules = [organizerUpn, ...attendeeEmails.filter((a) => a && a !== organizerUpn)];
  const data = await getSchedule(organizerUpn, schedules, wallIso(start), wallIso(end), INTERVAL);

  // Graph returns per-mailbox errors when free/busy isn't visible to the caller.
  const blocked = data.filter((d) => d.error?.message);
  if (blocked.length && blocked.length === data.length) {
    const msg = blocked[0].error?.message || "ไม่มีสิทธิ์ดูตาราง";
    throw new Error(`ไม่มีสิทธิ์ดูตารางตาม Microsoft 365: ${msg}`);
  }

  const orgDomain = (organizerUpn.split("@")[1] || "").toLowerCase();
  const isExternalish = (email: string) => {
    const d = (email.split("@")[1] || "").toLowerCase();
    return !d || !orgDomain || d !== orgDomain;
  };

  // Use organizer (or longest) view as the grid length. External Gmail etc. often return
  // empty availabilityView — treat those as always-free so they don't zero out all slots.
  const orgRow =
    data.find((d) => (d.scheduleId || "").toLowerCase() === organizerUpn.toLowerCase()) ||
    data.find((d) => (d.availabilityView || "").length > 0);
  const refLen = (orgRow?.availabilityView || "").length || Math.max(0, ...data.map((d) => (d.availabilityView || "").length));
  const views = data.map((d) => {
    const v = d.availabilityView || "";
    const id = (d.scheduleId || "").toLowerCase();
    if (v.length >= refLen && refLen > 0) return v.slice(0, refLen);
    if (!refLen) return "";
    if (!v.length || d.error?.message || isExternalish(id)) return "0".repeat(refLen);
    return v.padEnd(refLen, "0");
  });
  const n = refLen;
  const need = Math.max(1, Math.ceil(durationMin / INTERVAL));
  let afterMin = opts?.afterMin ?? null;
  let beforeMin = opts?.beforeMin ?? null;
  // Tight after/before (== duration window) is an exact-time ask — handled via atMin, not grid band.
  if (
    atMin == null &&
    afterMin != null &&
    beforeMin != null &&
    beforeMin - afterMin <= durationMin + 1
  ) {
    // Fall through: treat as atMin below using afterMin
  }
  const resolvedAt =
    atMin != null
      ? atMin
      : afterMin != null && beforeMin != null && beforeMin - afterMin <= durationMin + 1
        ? afterMin
        : null;
  if (resolvedAt != null) {
    // Don't also filter the 30-min grid with an impossible 10-min band
    afterMin = null;
    beforeMin = null;
  }
  const allStarts = opts?.allStarts ?? false;
  const includeLunch = opts?.includeLunch ?? false;
  const workEnd = opts?.workEndHour ?? WORK_END_HOUR;
  // Explicit day (วันนี้/พรุ่งนี้/วันที่…) → include that day even if Sat/Sun
  const includeWeekend = opts?.includeWeekend ?? !!window;
  const cap = allStarts ? Math.max(maxSlots, 48) : maxSlots;

  const dayAllowed = (dow: number) => (dow >= 1 && dow <= 5) || (includeWeekend && (dow === 0 || dow === 6));

  const slots: Slot[] = [];

  // Exact clock time (นัดตอน 13:50) — check that window directly; 30-min grid can't start at :50.
  if (resolvedAt != null && window) {
    const now = nowWall();
    let slotStart = atMinuteOfDay(window.start, resolvedAt);
    const slotEnd = addMinutes(slotStart, durationMin);
    // Same-day exact ask: keep today's date even if start is a bit past (user typed วันนี้).
    const sameDayAsk = fmtDate(slotStart) === fmtDate(window.start);
    const stillUseful = slotEnd.getTime() > now.getTime() - 5 * 60_000;
    const withinGrace = slotStart.getTime() >= now.getTime() - 90 * 60_000;
    if (sameDayAsk && stillUseful && withinGrace && slotStart < end) {
      const allFree = views.every((v) => !v.length || rangeIsFree(v, start, slotStart, slotEnd));
      const startMin = resolvedAt;
      const endMin = startMin + durationMin;
      const lunchOk = includeLunch || !overlapsLunch(startMin, endMin);
      const dow = slotStart.getUTCDay();
      const inHours = dayAllowed(dow) && endMin <= workEnd * 60 + 30;
      if (allFree && lunchOk && inHours) {
        slots.push({
          start: wallIso(slotStart),
          end: wallIso(slotEnd),
          label: `${fmtSlotRange(slotStart, slotEnd)}`,
        });
      }
    } else if (slotEnd > now && slotStart < end) {
      const graceStart = slotStart.getTime() < now.getTime() - 2 * 60_000 ? null : slotStart;
      if (graceStart) {
        const allFree = views.every((v) => rangeIsFree(v, start, slotStart, slotEnd));
        const startMin = resolvedAt;
        const endMin = startMin + durationMin;
        const lunchOk = includeLunch || !overlapsLunch(startMin, endMin);
        const dow = slotStart.getUTCDay();
        const inHours = dayAllowed(dow) && endMin <= workEnd * 60 + 30;
        if (allFree && lunchOk && inHours) {
          slots.push({
            start: wallIso(slotStart),
            end: wallIso(slotEnd),
            label: `${fmtSlotRange(slotStart, slotEnd)}`,
          });
        }
      }
    }
    // If exact time worked (or failed), still allow nearby grid suggestions when exact failed
    if (slots.length) {
      return { slots, busy: collectBusy(data, start), ranges: [...slots] };
    }
    // Exact miss on a single-day window → suggest later starts the SAME day only (not tomorrow).
    afterMin = resolvedAt;
  }

  let i = 0;
  while (i < n && slots.length < cap) {
    const slotStart = addMinutes(start, INTERVAL * i);
    const dow = slotStart.getUTCDay();
    const startMin = slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();
    const endMin = startMin + durationMin;
    const inHours =
      dayAllowed(dow) &&
      slotStart.getUTCHours() >= WORK_START_HOUR &&
      endMin <= workEnd * 60;
    const inBand =
      (afterMin === null || startMin >= afterMin) &&
      (beforeMin === null || startMin < beforeMin);
    // Lunch skip is for weekdays; weekends have no office lunch rule
    const lunchOk = includeLunch || dow === 0 || dow === 6 || !overlapsLunch(startMin, endMin);
    const allFree = views.every((v) => v.length >= i + need && v.slice(i, i + need) === "0".repeat(need));
    if (inHours && inBand && lunchOk && allFree) {
      const slotEnd = addMinutes(slotStart, durationMin);
      slots.push({
        start: wallIso(slotStart),
        end: wallIso(slotEnd),
        label: fmtSlotRange(slotStart, slotEnd),
      });
      i += allStarts ? 1 : need;
    } else {
      i += 1;
    }
  }

  // Merge consecutive bookable starts into continuous free ranges (for "show all times").
  const ranges: Slot[] = [];
  for (const s of slots) {
    const prev = ranges[ranges.length - 1];
    if (prev && prev.end === s.start) {
      prev.end = s.end;
      const ps = parseWallLabel(prev.start);
      const pe = parseWallLabel(prev.end);
      if (ps && pe) prev.label = fmtSlotRange(ps, pe);
    } else {
      ranges.push({ ...s });
    }
  }

  return { slots, busy: collectBusy(data, start), ranges };
}

/** Parse wall-iso "YYYY-MM-DDTHH:MM:SS" back to a Date with UTC fields = local. */
function parseWallLabel(iso: string): Date | null {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return isNaN(d.getTime()) ? null : d;
}

function collectBusy(data: { scheduleId?: string; scheduleItems?: unknown[] }[], searchStart: Date): BusyMap {
  const busy: BusyMap = {};
  for (const d of data) {
    const items = ((d.scheduleItems as Record<string, unknown>[]) || [])
      .map((it) => {
        const s = it.start as { dateTime?: string } | undefined;
        const e = it.end as { dateTime?: string } | undefined;
        return {
          start: s?.dateTime,
          end: e?.dateTime,
          subject: (it.subject as string) || "(ไม่ระบุ)",
          status: it.status as string,
        };
      })
      .filter((it) => {
        if (!it.end) return true;
        const raw = it.end.replace(/\.\d+/, "").replace(/Z$/, "");
        const e = parseWallLabel(raw);
        if (!e) return true;
        return e.getTime() > searchStart.getTime();
      })
      .slice(0, 5);
    busy[d.scheduleId || ""] = items;
  }
  return busy;
}

type Range = { start: Date; end: Date };

async function availabilityRanges(
  targetUpn: string,
  start: Date,
  end: Date,
  requesterUpn: string | undefined,
  keepFree: boolean,
  includeLunch = false
): Promise<Range[]> {
  const caller = requesterUpn || targetUpn;
  const data = await getSchedule(caller, [targetUpn], wallIso(start), wallIso(end), INTERVAL);
  const view = data[0]?.availabilityView || "";

  const ranges: Range[] = [];
  let cur: Range | null = null;
  for (let i = 0; i < view.length; i++) {
    const slot = addMinutes(start, INTERVAL * i);
    const dow = slot.getUTCDay();
    const startMin = slot.getUTCHours() * 60 + slot.getUTCMinutes();
    const endMin = startMin + INTERVAL;
    const inHours = dow >= 1 && dow <= 5 && slot.getUTCHours() >= WORK_START_HOUR && slot.getUTCHours() < WORK_END_HOUR;
    const lunchOk = includeLunch || !overlapsLunch(startMin, endMin);
    const match = keepFree ? inHours && lunchOk && view[i] === "0" : view[i] !== "0";
    if (match) {
      if (!cur) cur = { start: slot, end: addMinutes(slot, INTERVAL) };
      else cur.end = addMinutes(slot, INTERVAL);
    } else if (cur) {
      ranges.push(cur);
      cur = null;
    }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

/** Free time blocks (within working hours) for targetUpn. */
export async function freeRanges(
  targetUpn: string,
  start: Date,
  end: Date,
  requesterUpn?: string,
  includeLunch = false
): Promise<Range[]> {
  const now = nowWall();
  if (start < now) {
    start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
  }
  return availabilityRanges(targetUpn, start, end, requesterUpn, true, includeLunch);
}

/** Busy time blocks for targetUpn (when they're tied up — never meeting subjects). */
export async function busyRanges(
  targetUpn: string,
  start: Date,
  end: Date,
  requesterUpn?: string
): Promise<Range[]> {
  return availabilityRanges(targetUpn, start, end, requesterUpn, false);
}

/** Every calendar day this window touches falls on a weekend. */
function isWeekendWindow(start: Date, end: Date): boolean {
  for (let d = startOfDay(start); d <= end; d = addDays(d, 1)) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) return false;
  }
  return true;
}

const THAI_DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

/**
 * "วันเสาร์ที่ 29/08/2026" for a single day, "ช่วง <label>" for a span.
 *
 * People ask with a weekday ("เสาร์นี้") and were answered with a bare
 * "29/08/2026", which makes them check a calendar to confirm the assistant
 * understood them. Naming the day says yes, we heard you.
 */
function dayLabel(start: Date, end: Date, label: string): string {
  const oneDay = addDays(startOfDay(start), 1) >= end;
  const name = THAI_DOW[start.getUTCDay()];
  return oneDay && name ? `วัน${name}ที่ ${label}` : `ช่วง ${label}`;
}

/** Any working slot left in this window once the past is dropped. */
function workingHoursRemain(start: Date, end: Date): boolean {
  const now = nowWall();
  let slot = start < now ? new Date(now) : new Date(start);
  slot.setUTCMinutes(0, 0, 0);
  for (; slot < end; slot = addMinutes(slot, INTERVAL)) {
    const dow = slot.getUTCDay();
    const h = slot.getUTCHours();
    if (dow >= 1 && dow <= 5 && h >= WORK_START_HOUR && h < WORK_END_HOUR) return true;
  }
  return false;
}

/**
 * `window` is the span that was asked about — pass it whenever you have it.
 *
 * "no free ranges" means three very different things, and the old text asserted
 * the rarest one for all of them: "เสาร์นี้ว่างไหม" came back "ไม่มีเวลาว่าง
 * ในเวลาทำงานเลยครับ (คิวแน่นมาก!)" because Saturday has no working hours to be
 * free in — the calendar was empty, not packed. Asking after 17:00 on a weekday
 * had the same shape and the same wrong answer.
 */
export function formatFree(
  ranges: Range[],
  label: string,
  who = "คุณ",
  window?: { start: Date; end: Date }
): string {
  if (!ranges.length) {
    if (window && isWeekendWindow(window.start, window.end)) {
      return `${dayLabel(window.start, window.end, label)} เป็นวันหยุดครับ 🌤️`;
    }
    if (window && !workingHoursRemain(window.start, window.end)) {
      return (
        `ช่วง ${label} เลยเวลาทำงาน (${WORK_START_HOUR}:00–${WORK_END_HOUR}:00) ไปแล้วครับ ⏰\n\n` +
        `ลองถามเป็นวันถัดไปดูไหมครับ เช่น “ว่างกี่โมงพรุ่งนี้”`
      );
    }
    return `ช่วง ${label} ${who}ไม่มีเวลาว่างในเวลาทำงานเลยครับ (คิวแน่นมาก! 😮)`;
  }
  const lines = [`🗓️ เวลาว่างของ${who} (${label}):`, ""];
  let lastDay: string | null = null;
  for (const r of ranges) {
    const day = fmtDayHeader(r.start);
    if (day !== lastDay) {
      lines.push(`— ${day} —`);
      lastDay = day;
    }
    lines.push(`  ${fmtTime(r.start)} - ${fmtTime(r.end)}`);
  }
  return lines.join("\n");
}

/**
 * Free ranges plus the sentence that describes them.
 *
 * "เสาร์นี้ว่างไหม" is one question, so it deserves one answer: it is a
 * weekend, and here is what is on the calendar anyway. The previous version
 * said only the first half and told the person to go type
 * "ตาราง 29/08/2026" for the second — sending them off to do a lookup we were
 * already holding the connection for.
 *
 * The second read only happens on a weekend with nothing free, so a weekday
 * "ว่างกี่โมงพรุ่งนี้" still costs exactly one call.
 */
export async function freeRangesReply(opts: {
  targetUpn: string;
  start: Date;
  end: Date;
  requesterUpn?: string;
  label: string;
  /** Whose calendar this is, as it should read in a sentence. */
  who?: string;
  includeLunch?: boolean;
}): Promise<{ ranges: Range[]; reply: string }> {
  const { targetUpn, start, end, requesterUpn, label, includeLunch = false } = opts;
  const who = opts.who || "คุณ";
  const ranges = await freeRanges(targetUpn, start, end, requesterUpn, includeLunch);
  if (ranges.length || !isWeekendWindow(start, end)) {
    return { ranges, reply: formatFree(ranges, label, who, { start, end }) };
  }

  const day = dayLabel(start, end, label);
  const whose = who === "คุณ" ? "ตาราง" : `ตารางของ ${who}`;
  let busy: Range[] = [];
  try {
    busy = await busyRanges(targetUpn, start, end, requesterUpn);
  } catch (e) {
    // A weekend answer without the calendar half still beats no answer at all.
    console.warn("freeRangesReply busy lookup failed:", e);
    return { ranges, reply: `${day} เป็นวันหยุดครับ 🌤️` };
  }

  if (!busy.length) {
    return {
      ranges,
      reply: `${day} เป็นวันหยุด และ${whose}ยังว่างอยู่ ไม่มีนัดอะไรเลยครับ 🌤️`,
    };
  }
  // Say what the meetings ARE, and count meetings — not blocks.
  //
  // busyRanges() merges adjacent 30-minute slots and never carries a subject,
  // so three back-to-back meetings came back as "มีนัดอยู่ 1 ช่วง" over a bare
  // time span: a wrong number attached to an answer that never said what was on
  // the calendar anyway. The events are one call away, and the ตาราง command
  // has been listing them by name all along.
  //
  // Own diary only: getEventsRange() reads /me with a delegated token, so
  // pointing it at a colleague would quietly return YOUR calendar under THEIR
  // name. For anyone else the busy blocks stay, described as what they honestly
  // are — hours that are not free, subjects we are not allowed to see.
  const own = !requesterUpn || requesterUpn.toLowerCase() === targetUpn.toLowerCase();
  if (own) {
    try {
      const events = await getEventsRange(targetUpn, wallIso(start), wallIso(end));
      if (events.length) {
        const lines = events
          .slice()
          .sort((a, b) => (a.start?.dateTime || "").localeCompare(b.start?.dateTime || ""))
          .map((ev) => {
            // parseWall, never new Date(): Graph sends "2026-08-29T10:00:00"
            // with no offset, which new Date() reads as machine-local and
            // fmtTime then re-reads as UTC — a 10:00 meeting printed 03:00.
            const st = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
            const en = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
            const when = st && en ? `${fmtTime(st)}-${fmtTime(en)}` : "?";
            const place = ev.location?.displayName ? ` 📍 ${ev.location.displayName}` : "";
            return `  ${when} · ${ev.subject || "(ไม่มีหัวข้อ)"}${place}`;
          });
        return {
          ranges,
          reply: [`${day} เป็นวันหยุดครับ แต่มีนัดอยู่ ${events.length} รายการ 📌`, "", ...lines].join("\n"),
        };
      }
    } catch (e) {
      console.warn("freeRangesReply event lookup failed:", e);
    }
  }

  return {
    ranges,
    reply: [
      `${day} เป็นวันหยุดครับ แต่${who === "คุณ" ? "คุณ" : who}ติดอยู่ ${busy.length} ช่วง 📌`,
      "",
      ...busy.map((b) => `  ${fmtTime(b.start)} - ${fmtTime(b.end)}`),
      "",
      "💡 เห็นได้แค่ช่วงเวลา หัวข้อนัดของคนอื่นต้องดูใน Outlook ครับ",
    ].join("\n"),
  };
}

export function formatBusy(busy: BusyMap): string {
  const lines = ["หาเวลาที่ทุกคนว่างตรงกันไม่เจอในช่วงที่ขอครับ 😅", "", "ตารางที่เห็น:"];
  for (const [email, items] of Object.entries(busy)) {
    if (!items.length) {
      lines.push(`  • ${email}: ไม่มีรายการติดในช่วงที่ค้น`);
      continue;
    }
    const parts: string[] = [];
    for (const it of items.slice(0, 3)) {
      let span = "";
      if (it.start || it.end) {
        const s = it.start ? new Date(it.start.replace(/\.\d+/, "") + "Z") : null;
        const e = it.end ? new Date(it.end.replace(/\.\d+/, "") + "Z") : null;
        const fmt = (d: Date) =>
          `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${fmtTime(d)}`;
        if (s && e && !isNaN(s.getTime()) && !isNaN(e.getTime())) span = ` ${fmt(s)}–${fmt(e)}`;
        else if (e && !isNaN(e.getTime())) span = ` ถึง ${fmt(e)}`;
      }
      parts.push(`“${it.subject}”${span}`);
    }
    lines.push(`  • ${email}: ${parts.join("; ")}` + (items.length > 3 ? " …" : ""));
  }
  lines.push("", "ถ้ายังไม่ตรง ลองพิมพ์วัน/ช่วงใหม่ได้ เช่น “พรุ่งนี้” หรือ “ช่วงบ่าย” ครับ");
  return lines.join("\n");
}
