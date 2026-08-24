// Wall-clock time helpers for the configured timezone (Asia/Bangkok, UTC+7,
// no DST). We represent local "wall clock" datetimes as JS Dates whose UTC
// fields hold the local components — mirroring the naive datetimes the Python
// app used — and convert at the edges (Graph API, Supabase).

export const TZ_OFFSET_MIN = 7 * 60; // Asia/Bangkok

/** Current wall-clock time (UTC fields = Bangkok local components). */
export function nowWall(): Date {
  return new Date(Date.now() + TZ_OFFSET_MIN * 60_000);
}

/** Parse a Graph dateTime (already in local tz thanks to Prefer header) or ISO string to wall clock. */
export function parseWall(s: string): Date | null {
  if (!s) return null;
  let t = s.trim().replace(" ", "T");
  // Strip sub-second precision Graph adds ("2026-07-30T09:00:00.0000000")
  t = t.replace(/\.\d+/, "");
  if (t.endsWith("Z")) t = t.slice(0, -1);
  // If an explicit offset is present, convert to our wall clock
  const m = t.match(/([+-]\d{2}):?(\d{2})$/);
  if (m) {
    const base = new Date(t);
    if (isNaN(base.getTime())) return null;
    return new Date(base.getTime() + TZ_OFFSET_MIN * 60_000);
  }
  const d = new Date(t + "Z");
  return isNaN(d.getTime()) ? null : d;
}

/** Wall-clock date -> "YYYY-MM-DDTHH:MM:SS" (no offset). */
export function wallIso(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/** Wall-clock date -> real UTC ISO string (for storing in timestamptz columns). */
export function wallToUtcIso(d: Date): string {
  return new Date(d.getTime() - TZ_OFFSET_MIN * 60_000).toISOString();
}

/** Real UTC ISO (e.g. from Supabase) -> wall-clock date. */
export function utcIsoToWall(iso: string): Date | null {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : new Date(d.getTime() + TZ_OFFSET_MIN * 60_000);
}

export function fmtDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

export function fmtTime(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

const THAI_WEEKDAY_NAMES = [
  "วันอาทิตย์",
  "วันจันทร์",
  "วันอังคาร",
  "วันพุธ",
  "วันพฤหัสบดี",
  "วันศุกร์",
  "วันเสาร์",
] as const;

export function thaiWeekday(d: Date): string {
  return THAI_WEEKDAY_NAMES[d.getUTCDay()] || "";
}

export function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/** Fixed Thai public / observed holidays (YYYY-MM-DD → name). Extend yearly as needed. */
const THAI_HOLIDAYS: Record<string, string> = {
  "2025-01-01": "วันขึ้นปีใหม่",
  "2025-02-12": "วันมาฆบูชา",
  "2025-04-06": "วันจักรี",
  "2025-04-07": "ชดเชยวันจักรี",
  "2025-04-13": "วันสงกรานต์",
  "2025-04-14": "วันสงกรานต์",
  "2025-04-15": "วันสงกรานต์",
  "2025-04-16": "ชดเชยวันสงกรานต์",
  "2025-05-01": "วันแรงงานแห่งชาติ",
  "2025-05-05": "วันฉัตรมงคล",
  "2025-05-09": "วันพืชมงคล",
  "2025-05-12": "วันวิสาขบูชา",
  "2025-06-02": "ชดเชยวันเฉลิมพระชนมพรรษา สมเด็จพระนางเจ้าสุทิดา",
  "2025-06-03": "วันเฉลิมพระชนมพรรษา สมเด็จพระนางเจ้าสุทิดา",
  "2025-07-10": "วันอาสาฬหบูชา",
  "2025-07-11": "วันเข้าพรรษา",
  "2025-07-28": "วันเฉลิมพระชนมพรรษา ร.10",
  "2025-08-11": "ชดเชยวันแม่แห่งชาติ",
  "2025-08-12": "วันแม่แห่งชาติ",
  "2025-10-13": "วันคล้ายวันสวรรคต ร.9",
  "2025-10-23": "วันปิยมหาราช",
  "2025-12-05": "วันพ่อแห่งชาติ",
  "2025-12-10": "วันรัฐธรรมนูญ",
  "2025-12-31": "วันสิ้นปี",
  "2026-01-01": "วันขึ้นปีใหม่",
  "2026-01-02": "ชดเชยวันขึ้นปีใหม่",
  "2026-03-03": "วันมาฆบูชา",
  "2026-04-06": "วันจักรี",
  "2026-04-13": "วันสงกรานต์",
  "2026-04-14": "วันสงกรานต์",
  "2026-04-15": "วันสงกรานต์",
  "2026-05-01": "วันแรงงานแห่งชาติ",
  "2026-05-04": "ชดเชยวันฉัตรมงคล",
  "2026-05-05": "วันฉัตรมงคล",
  "2026-05-11": "วันพืชมงคล",
  "2026-06-01": "วันวิสาขบูชา",
  "2026-06-03": "วันเฉลิมพระชนมพรรษา สมเด็จพระนางเจ้าสุทิดา",
  "2026-06-29": "วันอาสาฬหบูชา",
  "2026-06-30": "วันเข้าพรรษา",
  "2026-07-28": "วันเฉลิมพระชนมพรรษา ร.10",
  "2026-08-12": "วันแม่แห่งชาติ",
  "2026-10-13": "วันคล้ายวันสวรรคต ร.9",
  "2026-10-23": "วันปิยมหาราช",
  "2026-12-05": "วันพ่อแห่งชาติ",
  "2026-12-07": "ชดเชยวันพ่อแห่งชาติ",
  "2026-12-10": "วันรัฐธรรมนูญ",
  "2026-12-31": "วันสิ้นปี",
};

function ymdKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function thaiHolidayName(d: Date): string | null {
  return THAI_HOLIDAYS[ymdKey(d)] || null;
}

/**
 * Non-work-day tag for replies: "วันเสาร์", "วันอาทิตย์", "วันหยุด (…)",
 * or "วันเสาร์ · วันหยุด (…)" when both apply. Null on a normal weekday.
 */
export function nonWorkDayNote(d: Date): string | null {
  const hol = thaiHolidayName(d);
  const wk = isWeekend(d) ? thaiWeekday(d) : "";
  if (hol && wk) return `${wk} · วันหยุด (${hol})`;
  if (hol) return `วันหยุด (${hol})`;
  if (wk) return wk;
  return null;
}

/** Append weekend/holiday to a day label like "พรุ่งนี้" → "พรุ่งนี้ · วันเสาร์". */
export function enrichDayLabel(base: string, d: Date): string {
  const note = nonWorkDayNote(d);
  if (!note) return base;
  if (!base) return note;
  if (base.includes(note) || /วันเสาร์|วันอาทิตย์|วันหยุด/.test(base)) return base;
  return `${base} · ${note}`;
}

/** Slot line: "08/08/2026 วันเสาร์ 09:00-09:30" when Sat/Sun/holiday. */
export function fmtSlotRange(start: Date, end: Date): string {
  const note = nonWorkDayNote(start);
  if (note) return `${fmtDate(start)} ${note} ${fmtTime(start)}-${fmtTime(end)}`;
  return `${fmtDateTime(start)}-${fmtTime(end)}`;
}

/** Date header for lists: "13/08/2026" or "08/08/2026 วันเสาร์". */
export function fmtDayHeader(d: Date): string {
  const note = nonWorkDayNote(d);
  return note ? `${fmtDate(d)} ${note}` : fmtDate(d);
}

export function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

export function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(23, 59, 59, 999);
  return r;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000);
}

/** Map a period keyword to {start, end, label(th)} in wall-clock time. */
export function periodRange(period: string): { start: Date; end: Date; label: string } {
  const now = nowWall();
  const today = startOfDay(now);
  if (period === "tomorrow") {
    const d = addDays(today, 1);
    return { start: d, end: endOfDay(d), label: "พรุ่งนี้" };
  }
  if (period === "week") return { start: today, end: addDays(today, 7), label: "7 วันข้างหน้า" };
  if (period === "month") {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    return { start: first, end: next, label: "เดือนนี้" };
  }
  if (period === "upcoming") return { start: today, end: addDays(today, 14), label: "ช่วง 2 สัปดาห์ข้างหน้า" };
  return { start: today, end: endOfDay(today), label: "วันนี้" };
}

/** Turn a specific-date hint ("31", "31/07", "2026-07-31") into a single-day range, or null. */
export function resolveDay(dateStr: string): { start: Date; end: Date; label: string } | null {
  const s = (dateStr || "").trim();
  const today = startOfDay(nowWall());
  let d: Date | null = null;
  try {
    if (s.includes("-")) {
      const [y, m, day] = s.split("-").map(Number);
      if (y && m && day) d = new Date(Date.UTC(y, m - 1, day));
    } else if (s.includes("/")) {
      const parts = s.split("/").map(Number);
      const [day, m] = parts;
      const y = parts.length > 2 ? parts[2] : today.getUTCFullYear();
      if (day && m) d = new Date(Date.UTC(y, m - 1, day));
    } else if (/^\d+$/.test(s)) {
      const day = Number(s);
      d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day));
      if (d < today) d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, day));
    }
  } catch {
    return null;
  }
  if (!d || isNaN(d.getTime())) return null;
  return { start: d, end: endOfDay(d), label: fmtDate(d) };
}

/** Map Thai month aliases (short/long) to 1–12. */
function thaiMonthNum(token: string): number | null {
  const s = (token || "").replace(/\./g, "").replace(/\s+/g, "").toLowerCase();
  const map: Record<string, number> = {
    มค: 1,
    มกรา: 1,
    มกราคม: 1,
    กพ: 2,
    กุมภา: 2,
    กุมภาพันธ์: 2,
    มีค: 3,
    มีนา: 3,
    มีนาคม: 3,
    เมย: 4,
    เมษา: 4,
    เมษายน: 4,
    พค: 5,
    พฤษภา: 5,
    พฤษภาคม: 5,
    มิย: 6,
    มิถุนา: 6,
    มิถุนายน: 6,
    กค: 7,
    กรกฎา: 7,
    กรกฎาคม: 7,
    สค: 8,
    สิงหา: 8,
    สิงหาคม: 8,
    กย: 9,
    กันยา: 9,
    กันยายน: 9,
    ตค: 10,
    ตุลา: 10,
    ตุลาคม: 10,
    พย: 11,
    พฤศจิกา: 11,
    พฤศจิกายน: 11,
    ธค: 12,
    ธันวา: 12,
    ธันวาคม: 12,
  };
  return map[s] ?? null;
}

/**
 * Parse Thai calendar dates in free text — e.g. "วันที่ 5 กันยา", "5 ก.ย. 2569", "5/9".
 * Returns null when no concrete date is found.
 */

/** Thai month names, full and abbreviated, without a day in front. */
const THAI_MONTH_ONLY =
  /(?:^|[^\d])(?:เดือน\s*)?(ม\.?ค\.?|ก\.?พ\.?|มี\.?ค\.?|เม\.?ย\.?|พ\.?ค\.?|มิ\.?ย\.?|ก\.?ค\.?|ส\.?ค\.?|ก\.?ย\.?|ต\.?ค\.?|พ\.?ย\.?|ธ\.?ค\.?|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)(?:\s*(?:พ\.?\s*ศ\.?\s*)?(\d{4}|\d{2}))?/u;

/**
 * "เดือนกรกฎาคม", "ส.ค. 2569", "ธันวาคมปีที่แล้ว" → that whole month.
 *
 * Naming a month used to fall through to period=month, which always means the
 * CURRENT month: asking in August for กรกฎาคม answered with August. A month
 * with no year means the nearest one — this year unless that lands more than
 * six months ahead, in which case the year before is what was meant.
 *
 * Returns null when a day number precedes the month ("31 ก.ค."), which is a
 * single date and already handled.
 */
export function resolveThaiMonthRange(
  text: string
): { start: Date; end: Date; label: string } | null {
  const t = (text || "").trim();
  if (!t) return null;
  // A day in front makes it a date, not a month.
  if (/\d{1,2}\s*(?:ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค|มกรา|กุมภา|มีนา|เมษา|พฤษภา|มิถุนา|กรกฎา|สิงหา|กันยา|ตุลา|พฤศจิ|ธันวา)/u.test(t)) {
    return null;
  }
  const m = THAI_MONTH_ONLY.exec(t);
  if (!m) return null;
  const mo = thaiMonthNum(m[1]!);
  if (!mo) return null;

  const now = nowWall();
  let year = now.getUTCFullYear();
  if (m[2]) {
    let y = Number(m[2]);
    if (y > 2400) y -= 543; // พ.ศ.
    else if (y < 100) y += y > 50 ? 2400 - 543 : 2000; // "68" → 2568 → 2025
    year = y;
  } else {
    const monthsAhead = mo - 1 - now.getUTCMonth();
    if (monthsAhead > 6) year -= 1;
    if (/ปีที่แล้ว|ปีก่อน/u.test(t)) year -= 1;
    if (/ปีหน้า/u.test(t)) year += 1;
  }

  const start = new Date(Date.UTC(year, mo - 1, 1));
  const end = new Date(Date.UTC(year, mo, 1));
  const names = [
    "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
    "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม",
  ];
  return { start, end, label: `${names[mo - 1]} ${year + 543}` };
}

export function resolveThaiDateInText(text: string): { start: Date; end: Date; label: string } | null {
  const t = (text || "").trim();
  if (!t) return null;

  const slash = t.match(/(?:วันที่\s*)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (slash) {
    const day = Number(slash[1]);
    const mo = Number(slash[2]);
    let y = slash[3] ? Number(slash[3]) : nowWall().getUTCFullYear();
    if (y < 100) y += y > 50 ? 1900 : 2000;
    const d = new Date(Date.UTC(y, mo - 1, day));
    if (!isNaN(d.getTime())) return { start: d, end: endOfDay(d), label: fmtDate(d) };
  }

  const iso = t.match(/(?:วันที่\s*)?(\d{4}-\d{2}-\d{2})/);
  if (iso) return resolveDay(iso[1]!);

  const thai = t.match(
    /(?:วันที่\s*)?(\d{1,2})\s*(ม\.?ค\.?|ก\.?พ\.?|มี\.?ค\.?|เม\.?ย\.?|พ\.?ค\.?|มิ\.?ย\.?|ก\.?ค\.?|ส\.?ค\.?|ก\.?ย\.?|ต\.?ค\.?|พ\.?ย\.?|ธ\.?ค\.?|มกร(?:า(?:คม)?)?|กุมภ(?:า(?:พันธ์)?)?|มีน(?:า(?:คม)?)?|เมษ(?:า(?:ยน)?)?|พฤษ(?:ภ(?:า(?:คม)?)?)?|มิถุ(?:น(?:า(?:ยน)?)?)?|กรก(?:ฎ(?:า(?:คม)?)?)?|สิงห(?:า(?:คม)?)?|กันย(?:า(?:ยน)?)?|ตุล(?:า(?:คม)?)?|พฤศ(?:จ(?:ิ(?:ก(?:า(?:ยน)?)?)?)?)?|ธันว(?:า(?:คม)?)?)(?:\s*(?:พ\.?\s*ศ\.?\s*)?(\d{4}|\d{2}))?/iu
  );
  if (thai) {
    const day = Number(thai[1]);
    const mo = thaiMonthNum(thai[2]!);
    if (mo && day >= 1 && day <= 31) {
      let y = thai[3] ? Number(thai[3]) : nowWall().getUTCFullYear();
      if (y > 2400) y -= 543;
      else if (y < 100) y += y > 50 ? 1900 : 2000;
      const d = new Date(Date.UTC(y, mo - 1, day));
      if (!isNaN(d.getTime())) return { start: d, end: endOfDay(d), label: fmtDate(d) };
    }
  }

  const bare = t.match(/(?:วันที่\s*)(\d{1,2})(?!\s*[\/\-]|\s*(?:ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค|มกร|กุมภ|มีน|เมษ|พฤษ|มิถุ|กรก|สิงห|กันย|ตุล|พฤศ|ธันว))/iu);
  if (bare) return resolveDay(bare[1]!);

  return null;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, "อาทิตย์": 0,
  mon: 1, monday: 1, "จันทร์": 1,
  tue: 2, tuesday: 2, "อังคาร": 2,
  wed: 3, wednesday: 3, "พุธ": 3,
  thu: 4, thursday: 4, "พฤหัส": 4, "พฤหัสบดี": 4,
  fri: 5, friday: 5, "ศุกร์": 5,
  sat: 6, saturday: 6, "เสาร์": 6,
};

/** Turn a weekday name ("mon", "จันทร์", "เสาร์นี้", "อาทิตย์หน้า") into that
 *  day's single-day range (the next upcoming occurrence), or null. */
export function resolveWeekday(name: string): { start: Date; end: Date; label: string } | null {
  const raw = (name || "").toLowerCase().trim();
  const key = raw.replace(/^วัน/, "").replace(/(นี้|หน้า)$/, "").trim();
  const wd = WEEKDAYS[key];
  if (wd === undefined) return null;
  const today = startOfDay(nowWall());
  let diff = (wd - today.getUTCDay() + 7) % 7; // 0 = today
  if (/หน้า/.test(raw) && diff === 0) diff = 7; // "…หน้า" on the same weekday = next week
  const d = addDays(today, diff);
  return { start: d, end: endOfDay(d), label: fmtDate(d) };
}

/** Parse "HH:MM" into minutes-of-day, or null. */
export function parseHHMM(s: unknown): number | null {
  const m = String(s || "").match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/**
 * Parse Thai / casual clock phrases into "HH:MM".
 * Examples: "ตอน 11 โมง", "บ่ายโมง", "6โมง", "ตี 5", "1ทุ่ม", "ตอนเที่ยง"
 */
export function parseThaiClockToHHMM(text: string): string | null {
  const t0 = (text || "").trim().replace(/\s+/g, " ");
  if (!t0) return null;
  // Common typo บ่าน → บ่าย
  const t = t0.replace(/บ่าน/g, "บ่าย");

  const colon = t.match(/(?:ตอน|เวลา|ที่)?\s*(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (colon) {
    const h = Number(colon[1]);
    const mi = Number(colon[2]);
    if (h < 24 && mi < 60) return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }

  const wordMap: Record<string, number> = {
    หนึ่ง: 1,
    สอง: 2,
    สาม: 3,
    สี่: 4,
    ห้า: 5,
    หก: 6,
    เจ็ด: 7,
    แปด: 8,
    เก้า: 9,
    สิบ: 10,
    สิบเอ็ด: 11,
    สิบสอง: 12,
  };
  const numToken = (raw: string) => wordMap[raw] ?? Number(raw);
  const hhmm = (h: number, mi = 0) =>
    h >= 0 && h < 24 && mi < 60 ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : null;

  // บ่ายโมง (no number) = 13:00 — must run before บ่าย+digit
  const baiBare = t.match(/(?:ตอน|เวลา|ที่)?\s*บ่าย\s*โมง(?:\s*เย็น)?(?:\s*(ครึ่ง))?/);
  if (baiBare && !/บ่าย\s*(\d|หนึ่ง|สอง|สาม|สี่|ห้า|หก)/.test(t)) {
    return hhmm(13, baiBare[1] ? 30 : 0);
  }

  // บ่าย2 / บ่าย4โมง / บ่าย4โมงเย็น / บ่ายสอง
  const bai = t.match(
    /(?:ตอน|เวลา|ที่)?\s*บ่าย\s*(\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า|หก)(?:\s*โมง)?(?:\s*เย็น)?(?:\s*(ครึ่ง))?/
  );
  if (bai) {
    const n = numToken(bai[1]);
    if (n >= 1 && n <= 6) {
      const h = n === 1 ? 13 : n + 12;
      return hhmm(h, bai[2] ? 30 : 0);
    }
  }

  // 1ทุ่ม / หนึ่งทุ่ม (number before ทุ่ม) — prefer over bare ทุ่ม
  const tumLead = t.match(
    /(?:ตอน|เวลา|ที่)?\s*(\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า)\s*ทุ่ม(?:\s*(ครึ่ง))?/
  );
  if (tumLead) {
    const n = numToken(tumLead[1]);
    if (n >= 1 && n <= 5) {
      const h = n === 1 ? 19 : n + 18;
      return hhmm(h, tumLead[2] ? 30 : 0);
    }
  }

  // ทุ่ม / ทุ่มหนึ่ง / ทุ่ม 2
  const tum = t.match(/(?:ตอน|เวลา|ที่)?\s*ทุ่ม\s*(\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า)?(?:\s*(ครึ่ง))?/);
  if (tum || /(?:^|[\s,])ทุ่ม(?=$|[\s,!.])/.test(t)) {
    const raw = tum?.[1];
    const n = raw ? numToken(raw) : 1;
    if (n >= 1 && n <= 5) {
      const h = n === 1 ? 19 : n + 18;
      return hhmm(h, tum?.[2] ? 30 : 0);
    }
  }

  // เที่ยงคืน → 00:00
  if (/(?:ตอน|เวลา|ที่)?\s*เที่ยงคืน/.test(t)) {
    return "00:00";
  }

  // Noon: "เที่ยง" / "ตอนเที่ยง" — not ก่อนเที่ยง·หลังเที่ยง·พักเที่ยง·ช่วงเที่ยง·มื้อเที่ยง·เที่ยงคืน
  if (!/(ก่อนเที่ยง|หลังเที่ยง|พักเที่ยง|ช่วงเที่ยง|มื้อเที่ยง|เที่ยงคืน)/.test(t)) {
    const noon =
      t.match(/(?:ตอน|เวลา|ที่)\s*เที่ยง(?:วัน|ตรง)?(?:\s*(ครึ่ง))?/) ||
      t.match(/(?:^|[\s,])เที่ยง(?:วัน|ตรง)?(?:\s*(ครึ่ง))?(?=$|[\s,!.])/);
    if (noon) {
      const half = noon[1] === "ครึ่ง" || /เที่ยง(?:วัน|ตรง)?\s*ครึ่ง/.test(t);
      return half ? "12:30" : "12:00";
    }
  }

  // ตี 5 / ตีห้า / ตอนตี1 → early morning 01:00–06:00
  const dti = t.match(
    /(?:ตอน|เวลา|ที่)?\s*ตี\s*(\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า|หก)(?:\s*(ครึ่ง))?/
  );
  if (dti) {
    const n = numToken(dti[1]);
    if (n >= 1 && n <= 6) return hhmm(n, dti[2] ? 30 : 0);
  }

  // 4โมงเย็น / 6โมงเย็น → 16:00 / 18:00
  const mongYen = t.match(/(?:ตอน|เวลา|ที่)?\s*(\d{1,2})\s*โมง\s*เย็น(?:\s*(ครึ่ง))?/);
  if (mongYen) {
    let h = Number(mongYen[1]);
    if (h >= 1 && h <= 6) h += 12;
    return hhmm(h, mongYen[2] ? 30 : 0);
  }

  // 4โมง / ตอน 11 โมง / 6โมง / 11 โมงครึ่ง
  // 1–5 โมง (ไม่มีเช้า) → บ่าย (13–17); 6โมง → 06:00 (เช้า); 6โมงเย็น จัดการด้านบนแล้ว
  const mong = t.match(/(?:ตอน|เวลา|ที่)?\s*(\d{1,2})\s*โมง(?:\s*(ครึ่ง|[\d]{1,2})\s*(?:นาที)?)?/);
  if (mong) {
    let h = Number(mong[1]);
    let mi = 0;
    if (mong[2] === "ครึ่ง") mi = 30;
    else if (mong[2] && /^\d+$/.test(mong[2])) mi = Math.min(59, Number(mong[2]));
    if (h >= 1 && h <= 5 && !/เช้า/.test(t)) h += 12;
    // h === 6 without เย็น stays 06:00
    return hhmm(h, mi);
  }

  return null;
}

/** Minutes-of-day from HH:MM or Thai clock phrase. */
export function parseClockToMinutes(text: unknown): number | null {
  const s = String(text || "").trim();
  if (!s) return null;
  const direct = parseHHMM(s);
  if (direct != null) return direct;
  const hh = parseThaiClockToHHMM(s);
  return hh ? parseHHMM(hh) : null;
}

export function minutesOfDay(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function fmtHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * A deadline written the way people say it: "พรุ่งนี้ 17:00", "วันศุกร์นี้",
 * "จันทร์ 12:00", "31 ก.ค.". Returns UTC ISO, or null when no day can be found.
 *
 * A due with no clock lands at 17:00 — end of the working day is what a
 * deadline without a time means here, and midnight would read as overdue all
 * afternoon.
 */
/**
 * "พรุ่งนี้", "มะรืน", "อีก 3 วัน", "สิ้นเดือน" — counted from today, not looked up.
 * periodRange() answers the same question for calendar views but has no way to
 * say "that is not a day", which a due date needs.
 */
function relativeDay(text: string): { start: Date; end: Date; label: string } | null {
  const t = (text || "").replace(/\s+/g, "").trim();
  if (!t) return null;
  const today = startOfDay(nowWall());
  const day = (d: Date, label: string) => ({ start: d, end: endOfDay(d), label });
  if (/^(?:วันนี้|คืนนี้|เช้านี้|บ่ายนี้|เย็นนี้)$/.test(t)) return day(today, "วันนี้");
  if (/^พรุ่ง(?:นี้)?$/.test(t)) return day(addDays(today, 1), "พรุ่งนี้");
  if (/^มะรืน(?:นี้)?$/.test(t)) return day(addDays(today, 2), "มะรืนนี้");
  const inDays = t.match(/^อีก(\d{1,2})วัน$/);
  if (inDays) return day(addDays(today, Number(inDays[1])), `อีก ${inDays[1]} วัน`);
  if (/^(?:สัปดาห์|อาทิตย์)หน้า$/.test(t)) return day(addDays(today, 7), "สัปดาห์หน้า");
  if (/^สิ้นเดือน(?:นี้)?$/.test(t)) {
    const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    return day(last, "สิ้นเดือน");
  }
  return null;
}

function thaiDueToIso(s: string): string | null {
  const clock = parseThaiClockToHHMM(s);
  // strip the time wording so only the day is left: "จันทร์ 9 โมง" → "จันทร์"
  const dayText = s
    .replace(/\d{1,2}[:.]\d{2}/g, " ")
    .replace(/\d{1,2}\s*(?:โมง|ทุ่ม|นาฬิกา)(?:เช้า|เย็น|ครื่ง)?/g, " ")
    .replace(/(?:เที่ยง(?:วัน|คืน)?|ตอนเช้า|ตอนบ่าย|ตอนเย็น|บ่ายสอง|บ่ายสาม|บ่ายโมง)/g, " ")
    .replace(/(?:เวลา|ตอน|ก่อน|ภายใน|ไม่เกิน)/g, " ")
    .trim();
  const day = relativeDay(dayText) || resolveDay(dayText) || resolveThaiDateInText(dayText) || resolveWeekday(dayText);
  if (!day) return null;
  const hhmm = clock || "06:00";
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = startOfDay(day.start);
  wall.setUTCHours(h, mi, 0, 0);
  return wallToUtcIso(wall);
}

/**
 * Normalize a free-text due date to a real UTC ISO string (or null).
 * Accepts ISO "YYYY-MM-DD[ HH:MM]", Thai-style day-first "DD/MM/YYYY [HH:MM]",
 * and relative Thai wording via thaiDueToIso.
 */
export function normalizeDue(dueRaw: unknown): string | null {
  const s = String(dueRaw ?? "").trim();
  if (!s || ["null", "none", "ไม่ระบุ"].includes(s.toLowerCase())) return null;
  const m = s.match(
    /^(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?)(?:[T ](\d{1,2}):(\d{2}))?/
  );
  if (!m) return thaiDueToIso(s);
  let y: number, mo: number, day: number;
  if (m[1]) {
    y = Number(m[1]);
    mo = Number(m[2]);
    day = Number(m[3]);
  } else {
    day = Number(m[4]);
    mo = Number(m[5]);
    y = m[6] ? Number(m[6]) : nowWall().getUTCFullYear();
  }
  const h = m[7] ? Number(m[7]) : 6;
  const mi = m[8] ? Number(m[8]) : 0;
  const wall = new Date(Date.UTC(y, mo - 1, day, h, mi));
  if (isNaN(wall.getTime())) return null;
  return wallToUtcIso(wall);
}
