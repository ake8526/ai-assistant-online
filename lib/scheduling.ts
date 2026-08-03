// Find common free slots + free/busy ranges — ported from morning_brief/scheduling.py.
// availabilityView: one char per interval: '0'=free, '1'=tentative, '2'=busy,
// '3'=out-of-office, '4'=working-elsewhere. A slot is bookable only if everyone is '0'.
import { getSchedule } from "@/lib/graph";
import { addDays, addMinutes, fmtDate, fmtDateTime, fmtTime, nowWall, wallIso } from "@/lib/time";

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

function searchWindow(override?: { start: Date; end: Date }): { start: Date; end: Date } {
  if (override) {
    const now = nowWall();
    let start = override.start;
    // If the window includes "now", don't offer slots in the past.
    if (start < now) {
      const rounded = new Date(now);
      rounded.setUTCMinutes(0, 0, 0);
      start = addMinutes(rounded, 60);
      if (start > override.end) start = override.end;
    }
    return { start, end: override.end };
  }
  const now = nowWall();
  now.setUTCMinutes(0, 0, 0);
  const start = addMinutes(now, 60);
  return { start, end: addDays(start, SCHEDULE_DAYS_AHEAD) };
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
    allStarts?: boolean;
    workEndHour?: number;
    /** When false (default), skip 12:00–13:00. */
    includeLunch?: boolean;
  }
): Promise<{ slots: Slot[]; busy: BusyMap; ranges: Slot[] }> {
  const { start, end } = searchWindow(window);
  const schedules = [organizerUpn, ...attendeeEmails.filter((a) => a && a !== organizerUpn)];
  const data = await getSchedule(organizerUpn, schedules, wallIso(start), wallIso(end), INTERVAL);

  // Graph returns per-mailbox errors when free/busy isn't visible to the caller.
  const blocked = data.filter((d) => d.error?.message);
  if (blocked.length && blocked.length === data.length) {
    const msg = blocked[0].error?.message || "ไม่มีสิทธิ์ดูตาราง";
    throw new Error(`ไม่มีสิทธิ์ดูตารางตาม Microsoft 365: ${msg}`);
  }

  const views = data.map((d) => d.availabilityView || "");
  const n = views.length ? Math.min(...views.map((v) => v.length)) : 0;
  const need = Math.max(1, Math.ceil(durationMin / INTERVAL));
  const afterMin = opts?.afterMin ?? null;
  const beforeMin = opts?.beforeMin ?? null;
  const allStarts = opts?.allStarts ?? false;
  const includeLunch = opts?.includeLunch ?? false;
  const workEnd = opts?.workEndHour ?? WORK_END_HOUR;
  const cap = allStarts ? Math.max(maxSlots, 48) : maxSlots;

  const slots: Slot[] = [];
  let i = 0;
  while (i < n && slots.length < cap) {
    const slotStart = addMinutes(start, INTERVAL * i);
    const dow = slotStart.getUTCDay();
    const startMin = slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();
    const endMin = startMin + durationMin;
    const inHours =
      dow >= 1 &&
      dow <= 5 &&
      slotStart.getUTCHours() >= WORK_START_HOUR &&
      endMin <= workEnd * 60;
    const inBand =
      (afterMin === null || startMin >= afterMin) &&
      (beforeMin === null || startMin < beforeMin);
    const lunchOk = includeLunch || !overlapsLunch(startMin, endMin);
    const allFree = views.every((v) => v.length >= i + need && v.slice(i, i + need) === "0".repeat(need));
    if (inHours && inBand && lunchOk && allFree) {
      const slotEnd = addMinutes(slotStart, durationMin);
      slots.push({
        start: wallIso(slotStart),
        end: wallIso(slotEnd),
        label: `${fmtDateTime(slotStart)}-${fmtTime(slotEnd)}`,
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
      if (ps && pe) prev.label = `${fmtDateTime(ps)}-${fmtTime(pe)}`;
    } else {
      ranges.push({ ...s });
    }
  }

  const busy: BusyMap = {};
  for (const d of data) {
    const items = ((d.scheduleItems as Record<string, unknown>[]) || []).slice(0, 5).map((it) => {
      const s = it.start as { dateTime?: string } | undefined;
      const e = it.end as { dateTime?: string } | undefined;
      return {
        start: s?.dateTime,
        end: e?.dateTime,
        subject: (it.subject as string) || "(ไม่ระบุ)",
        status: it.status as string,
      };
    });
    busy[d.scheduleId || ""] = items;
  }
  return { slots, busy, ranges };
}

/** Parse wall-iso "YYYY-MM-DDTHH:MM:SS" back to a Date with UTC fields = local. */
function parseWallLabel(iso: string): Date | null {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return isNaN(d.getTime()) ? null : d;
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

export function formatFree(ranges: Range[], label: string, who = "คุณ"): string {
  if (!ranges.length) return `ช่วง${label} ${who}ไม่มีเวลาว่างในเวลาทำงานเลยครับ (คิวแน่นมาก! 😮)`;
  const lines = [`🗓️ เวลาว่างของ${who} (${label}):`, ""];
  let lastDay: string | null = null;
  for (const r of ranges) {
    const day = fmtDate(r.start);
    if (day !== lastDay) {
      lines.push(`— ${day} —`);
      lastDay = day;
    }
    lines.push(`  ${fmtTime(r.start)} - ${fmtTime(r.end)}`);
  }
  return lines.join("\n");
}

export function formatBusy(busy: BusyMap): string {
  const lines = ["หาเวลาที่ทุกคนว่างตรงกันไม่เจอในช่วงนี้ครับ 😅", "", "ตารางที่ติด:"];
  for (const [email, items] of Object.entries(busy)) {
    if (!items.length) {
      lines.push(`  • ${email}: ว่างตลอด`);
      continue;
    }
    const first = items[0];
    let endT = "?";
    if (first.end) {
      const d = new Date(first.end.replace(/\.\d+/, "") + "Z");
      if (!isNaN(d.getTime()))
        endT = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${fmtTime(d)}`;
    }
    lines.push(`  • ${email}: ติด “${first.subject}” ถึง ${endT}` + (items.length > 1 ? " (และมีอีก)" : ""));
  }
  lines.push("", "ลองขยายช่วงวัน หรือระบุวันที่ต้องการเจาะจงได้ครับ");
  return lines.join("\n");
}
