"use client";

import React, { useCallback, useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

// ---------------------------------------------------------------------------
// /monitor/log — log ย้อนหลัง. /monitor is a live tail that starts at the tip;
// this page reads the same agent_traces rows by Bangkok day so a past morning
// can be audited (ใครถูกส่ง เวลาไหน ค้างตรงขั้นไหน). Stages only — no message
// text is ever stored, so nothing here can leak a conversation.
// ---------------------------------------------------------------------------

type LogEvent = { clock: string; step: string; label: string; status: string; ms: number };
type LogJob = {
  traceId: string;
  user: string;
  channel: string;
  clock: string;
  durationMs: number;
  title: string;
  outcome: "ok" | "quiet" | "error" | "incomplete";
  diagnosis?: string;
  events: LogEvent[];
};
type ActivityReason = {
  label: string;
  n: number;
  users: string[];
  traceId: string;
  clock: string;
};
type ActivityUser = {
  user: string;
  runs: number;
  ok: number;
  quiet: number;
  errors: number;
  incomplete: number;
  lastClock: string;
};
type Activity = {
  title: string;
  /** the pause switch this job answers to, when it has one */
  pauseKey?: string | null;
  runs: number;
  users: number;
  userList?: string[];
  byUser?: ActivityUser[];
  lastClock: string;
  lastAgoSec: number;
  ok: number;
  quiet: number;
  errors: number;
  incomplete: number;
  channel: string;
  reasons?: ActivityReason[];
};
type RunningJob = {
  traceId: string;
  user: string;
  channel: string;
  title: string;
  step: string;
  stepLabel: string;
  startedClock: string;
  elapsedSec: number;
  stages: number;
};
type PausedInfo = { jobs: string[]; labels: string[]; untilClock: string };
type LiveResp = {
  running: RunningJob[];
  paused?: PausedInfo | null;
  now: string;
  quietCutoffSec?: number;
};
type LogResp = {
  date: string;
  today?: boolean;
  perms?: string[];
  resolvedUsers?: { mail: string; name: string }[] | null;
  /** mailbox (full and local part) → the name shown in the directory */
  names?: Record<string, string>;
  truncated?: boolean;
  note?: string;
  activityWindowMin?: number;
  cronWindow?: { from: string; to: string; open: boolean; nowClock: string; source: string };
  activity?: Activity[];
  shownCount?: number;
  matchedCount?: number;
  summary: {
    traces: number;
    events: number;
    ok?: number;
    quiet?: number;
    errors?: number;
    incomplete?: number;
    users: string[];
    channels: string[];
  };
  traces: LogJob[];
};

const DEV = process.env.NODE_ENV !== "production";
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

const STEP_TH: Record<string, string> = {
  receive: "รับเรื่อง",
  parse: "แยกเจตนา",
  fetch: "ดึงข้อมูล",
  compose: "เขียนคำตอบ",
  reply: "ส่งออก",
  error: "ล้มเหลว",
};

/** "cron" is the machine's word for it. On a page people read to find out what
 *  the assistant did, this column should say what kind of trigger it was. The
 *  filter still sends the stored value ("cron") — only the label changes. */
const CHANNEL_TH: Record<string, string> = {
  cron: "ตั้งเวลา",
  line: "LINE",
  web: "เว็บ",
  ops: "ระบบ",
};
const channelTH = (c: string) => CHANNEL_TH[c] || c;
/** Job titles are stored as "cron · สรุปตารางเช้า". Where the row already has a
 *  channel column saying "ตั้งเวลา", repeating it in the title is noise — strip
 *  it there, translate it where the title stands alone. */
const titleShort = (t: string) => t.replace(/^cron[\s]*·[\s]*/, "");
const titleTH = (t: string) => t.replace(/^cron[\s]*·[\s]*/, "ตั้งเวลา · ");

const OUTCOME_TH: Record<LogJob["outcome"], string> = {
  ok: "สำเร็จ",
  quiet: "ไม่มีอะไรต้องส่ง",
  error: "ผิดพลาด",
  incomplete: "ไม่จบงาน",
};

function ago(sec: number): string {
  if (sec < 60) return `${sec} วินาทีที่แล้ว`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} นาทีที่แล้ว`;
  return `${Math.floor(m / 60)} ชม.${m % 60} นาทีที่แล้ว`;
}

function bkkToday(): string {
  return new Date(Date.now() + BKK_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}


const TH_MONTHS = [
  "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
  "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม",
];
const TH_MONTHS_SHORT = [
  "ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค.",
];
const TH_DOW = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** "2026-08-17" → "17 ส.ค. 2569" — Thai reads the Buddhist year. */
function thaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return iso;
  return `${d} ${TH_MONTHS_SHORT[m - 1] || ""} ${y + 543}`;
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Date picker per Rules_App/Calendar/1_Date_Only: never <input type="date">,
 * always a modal the page owns — closes on ✕, backdrop, or Esc, has a วันนี้
 * shortcut, and cannot select a day that makes no sense (there is no log from
 * the future, so those days are disabled rather than silently clamped).
 */
function CalendarModal({
  value,
  onPick,
  onClose,
  getToken,
}: {
  value: string;
  onPick: (iso: string) => void;
  onClose: () => void;
  getToken: () => Promise<string | null>;
}) {
  const [y0, m0] = value.split("-").map(Number);
  const [view, setView] = useState({ y: y0 || 2026, m: (m0 || 1) - 1 });
  const today = bkkToday();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  // Which days of the shown month actually have log. Until it answers, nothing
  // is disabled — better a moment of "all clickable" than greying out real days.
  useEffect(() => {
    let alive = true;
    const month = `${view.y}-${String(view.m + 1).padStart(2, "0")}`;
    const t = setTimeout(async () => {
      setCounts(null);
      try {
        const token = await getToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetch(`/api/monitor/log?days=${month}`, { headers, cache: "no-store" });
        if (!r.ok || !alive) return;
        const d = (await r.json()) as { counts?: Record<string, number> };
        if (alive) setCounts(d.counts || {});
      } catch {
        /* leave every day selectable */
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [view, getToken]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const first = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
  const days = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: first }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  const step = (by: number) => {
    const t = new Date(Date.UTC(view.y, view.m + by, 1));
    setView({ y: t.getUTCFullYear(), m: t.getUTCMonth() });
  };
  const nextDisabled = isoOf(view.y, view.m, 1) >= today.slice(0, 8) + "01";

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal cal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="mt pix">
          เลือกวันที่
          <button className="x" onClick={onClose} aria-label="ปิด">
            ✕
          </button>
        </div>
        <div className="cal-nav">
          <button onClick={() => step(-1)} aria-label="เดือนก่อน">
            ◀
          </button>
          <div className="cal-month">
            {TH_MONTHS[view.m]} {view.y + 543}
          </div>
          <button onClick={() => step(1)} disabled={nextDisabled} aria-label="เดือนถัดไป">
            ▶
          </button>
        </div>
        <div className="dow">
          {TH_DOW.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="days">
          {cells.map((d, i) => {
            if (!d) return <span key={`x${i}`} className="day empty" />;
            const iso = isoOf(view.y, view.m, d);
            const future = iso > today;
            const n = counts?.[iso];
            const empty = !!counts && !n;
            return (
              <button
                key={iso}
                className={`day${iso === value ? " on" : ""}${iso === today ? " today" : ""}${
                  empty ? " none" : ""
                }`}
                disabled={future || empty}
                title={
                  future
                    ? "ยังไม่ถึงวันนั้น"
                    : empty
                      ? `${thaiDate(iso)} — ไม่มี log`
                      : `${thaiDate(iso)}${n ? ` · ${n.toLocaleString()} ขั้นตอน` : ""}`
                }
                onClick={() => onPick(iso)}
              >
                {d}
              </button>
            );
          })}
        </div>
        <div className="calnote">
          {!counts
            ? "กำลังตรวจว่าวันไหนมี log…"
            : Object.keys(counts).length === 0
              ? "เดือนนี้ไม่มี log เลย — ลองเดือนอื่น"
              : "แสดงเฉพาะวันที่มี log — วันที่จางคือไม่มีข้อมูล"}
        </div>
        <div className="ma">
          <button onClick={() => onPick(today)}>วันนี้</button>
          <button onClick={onClose}>ปิด</button>
        </div>
      </div>
    </div>
  );
}

/* ---- Date field per Rules_App/Calendar/1_Date_Only ------------------------
 * No <input type="date">. Typed as DD/MM/YYYY with the slashes filled in, and
 * validated on EVERY digit: a keystroke that could not lead to a real date is
 * rejected outright (never clamped quietly), with the reason said out loud.
 * Both eras are accepted — พ.ศ. converts to ค.ศ. on the way in.
 * ------------------------------------------------------------------------ */
const CE_MIN = 1900, CE_MAX = 2200, BE_OFFSET = 543;
const BE_MIN = CE_MIN + BE_OFFSET, BE_MAX = CE_MAX + BE_OFFSET;

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const toCE = (y: number) => (y >= BE_MIN && y <= BE_MAX ? y - BE_OFFSET : y);

/** Could a year still land in an accepted range, given only its first digits? */
function yearPrefixOK(p: string): boolean {
  if (!p) return true;
  const pad = Math.pow(10, 4 - p.length);
  const lo = parseInt(p, 10) * pad;
  const hi = lo + pad - 1;
  return [
    [CE_MIN, CE_MAX],
    [BE_MIN, BE_MAX],
  ].some(([a, b]) => hi >= a && lo <= b);
}

/** Digit-by-digit gate. Returns the reason to refuse, or "" when still possible. */
function refuseReason(v: string, maxIso: string): string {
  if (v.length >= 1 && +v[0] > 3) return "วันที่ต้องอยู่ระหว่าง 01-31 (หลักแรกใส่ได้แค่ 0-3)";
  if (v.length >= 2) {
    const d = +v.slice(0, 2);
    if (d < 1 || d > 31) return "วันที่ต้องอยู่ระหว่าง 01-31";
  }
  if (v.length >= 3 && +v[2] > 1) return "เดือนต้องอยู่ระหว่าง 01-12 (หลักแรกใส่ได้แค่ 0-1)";
  if (v.length >= 4) {
    const m = +v.slice(2, 4);
    if (m < 1 || m > 12) return "เดือนต้องอยู่ระหว่าง 01-12";
  }
  if (v.length >= 5 && !yearPrefixOK(v.slice(4, 8)))
    return `ปีต้องเป็น ค.ศ. ${CE_MIN}-${CE_MAX} หรือ พ.ศ. ${BE_MIN}-${BE_MAX}`;
  if (v.length >= 8) {
    const d = +v.slice(0, 2);
    const m = +v.slice(2, 4);
    const y = toCE(+v.slice(4, 8));
    const max = daysInMonth(y, m);
    if (d > max) return `${TH_MONTHS[m - 1]} ${y + 543} มี ${max} วัน จึงไม่มีวันที่ ${d}`;
    if (isoOf(y, m - 1, d) > maxIso) return "ยังไม่ถึงวันนั้น — ยังไม่มี log ให้ดู";
  }
  return "";
}

function fmtDigits(v: string): string {
  if (v.length > 4) return `${v.slice(0, 2)}/${v.slice(2, 4)}/${v.slice(4, 8)}`;
  if (v.length > 2) return `${v.slice(0, 2)}/${v.slice(2, 4)}`;
  return v;
}

/** ISO (CE) → the digits a Thai user expects to see: DD/MM/พ.ศ. */
function digitsOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return "";
  return `${String(d).padStart(2, "0")}${String(m).padStart(2, "0")}${y + 543}`;
}

function DateField({
  value,
  onChange,
  onOpenCal,
}: {
  value: string;
  onChange: (iso: string) => void;
  onOpenCal: () => void;
}) {
  const [digits, setDigits] = useState(() => digitsOf(value));
  const [err, setErr] = useState("");
  const [shake, setShake] = useState(false);
  const lastValue = React.useRef(value);

  // The calendar and the day arrows also change the date — follow them.
  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setDigits(digitsOf(value));
      setErr("");
    }
  }, [value]);

  const reject = (why: string) => {
    setErr(why);
    setShake(true);
    setTimeout(() => setShake(false), 320);
  };

  const type = (raw: string) => {
    const next = raw.replace(/\D/g, "").slice(0, 8);
    if (next.length > digits.length) {
      const why = refuseReason(next, bkkToday());
      if (why) {
        reject(why); // keep the old digits — the bad keystroke never lands
        return;
      }
    }
    setErr("");
    setDigits(next);
    if (next.length === 8) {
      const y = toCE(+next.slice(4, 8));
      const iso = isoOf(y, +next.slice(2, 4) - 1, +next.slice(0, 2));
      lastValue.current = iso;
      onChange(iso);
    }
  };

  return (
    <span className="datefield">
      <span className={`well${err ? " bad" : ""}${shake ? " shake" : ""}`}>
        <input
          value={fmtDigits(digits)}
          onChange={(e) => type(e.target.value)}
          onBlur={() => {
            if (digits.length && digits.length < 8) reject("กรอกไม่ครบตามรูปแบบ DD/MM/YYYY");
          }}
          placeholder="DD/MM/YYYY"
          maxLength={10}
          inputMode="numeric"
          aria-label="วันที่ของ log"
        />
        <button className="cal-open" onClick={onOpenCal} title="เปิดปฏิทิน" aria-label="เปิดปฏิทิน">
          📅
        </button>
      </span>
      {err && <span className="fieldmsg">{err}</span>}
    </span>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@500;700&family=Press+Start+2P&family=VT323&display=swap');
.mlog{--bg:#0a0a0a;--panel:#121212;--panel2:#171717;--ink:#f5f5f5;--dim:#7c7c7c;--red:#ee1b24;--green:#39d353;--amber:#f0b429;--hair:#262626;
  background:var(--bg);color:var(--ink);font-family:'VT323','IBM Plex Sans Thai',monospace;min-height:100vh;padding:10px 12px 40px}
.mlog *{margin:0;padding:0;box-sizing:border-box}
.mlog .pix{font-family:'Press Start 2P',monospace}
.mlog header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:2px solid var(--hair);background:var(--panel);padding:8px 12px;margin-bottom:8px}
.mlog header h1{font-size:12px}.mlog header h1 em{color:var(--red);font-style:normal}
.mlog .spacer{flex:1}
.mlog a.link{font-size:14px;color:var(--dim);border:1px solid var(--hair);padding:3px 8px;text-decoration:none}
.mlog a.link:hover{color:var(--ink);border-color:var(--ink)}
.mlog .bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;border:2px solid var(--hair);background:var(--panel);padding:8px 10px;margin-bottom:8px}
.mlog input,.mlog select{background:var(--panel2);color:var(--ink);border:1px solid var(--hair);padding:4px 7px;font-family:inherit;font-size:16px}
.mlog input:focus,.mlog select:focus{outline:none;border-color:var(--red)}
.mlog button{background:var(--panel2);color:var(--ink);border:1px solid var(--hair);padding:4px 10px;font-family:inherit;font-size:16px;cursor:pointer}
.mlog button:hover{border-color:var(--ink)}
.mlog button.on{border-color:var(--red);color:#fff}
.mlog button.danger{border-color:var(--red);color:var(--red)}
.mlog button.danger:hover{background:var(--red);color:#fff}
.mlog button:disabled{opacity:.5;cursor:default}
.mlog .bar .spacer{flex:1}
.mlog .stats{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.mlog .stat{border:1px solid var(--hair);background:var(--panel);padding:4px 9px;font-size:15px;color:var(--dim)}
.mlog .stat b{font-size:18px}
.mlog .stat.ok b{color:var(--green)}.mlog .stat.err b{color:var(--red)}.mlog .stat.inc b{color:var(--amber)}
.mlog .stat.quiet b{color:#60a5fa}
/* "งานที่วนอยู่" — recurring cron work folded by job name */
.mlog .act{border:2px solid var(--hair);background:var(--panel);margin-bottom:8px}
.mlog .act .ah{font-size:8px;color:var(--dim);padding:6px 9px;border-bottom:2px solid var(--hair);background:var(--panel2)}
.mlog .act table{width:100%;border-collapse:collapse;font-size:16px}
.mlog .act th{text-align:left;color:var(--dim);font-weight:400;font-size:14px;padding:4px 9px;border-bottom:1px solid var(--hair)}
.mlog .act td{padding:4px 9px;border-bottom:1px solid #1c1c1c}
.mlog .act tr:last-child td{border-bottom:none}
.mlog .act td.n{color:var(--ink)}
.mlog .act tr.click{cursor:pointer}
.mlog .act tr.click:hover td{background:var(--panel2)}
.mlog .act tr.click.on td{background:#1c1c1c;box-shadow:inset 2px 0 0 var(--red)}
.mlog .act .dim{color:var(--dim);font-size:14px}
.mlog .tag{display:inline-block;border:1px solid var(--hair);padding:0 6px;margin-right:4px;font-size:14px}
.mlog .tag.ok{color:var(--green);border-color:#14532d}
.mlog .tag.quiet{color:#60a5fa;border-color:#1e3a8a}
.mlog .tag.err{color:var(--red);border-color:#7f1d1d}
.mlog .tag.inc{color:var(--amber);border-color:#78350f}
.mlog .tag.run{color:#fff;border-color:var(--red);background:rgba(238,27,36,.18)}
.mlog .act.live{border-color:var(--red)}
.mlog .act.live .ah{color:var(--ink)}
.mlog .act.live .ah .beat{color:var(--red);animation:mlogbeat 1s steps(1) infinite}
.mlog .act.live .idle{padding:10px;color:var(--dim);font-size:17px}
.mlog .act.live td.u{color:#7dd3fc}
@keyframes mlogbeat{0%{opacity:1}50%{opacity:.15}100%{opacity:1}}
.mlog .act.live .paused{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:7px 9px;border-bottom:1px solid var(--hair);background:rgba(240,180,41,.08);color:var(--amber);font-size:16px}
.mlog .datefield{display:inline-flex;flex-direction:column;gap:2px}
.mlog .well{display:inline-flex;align-items:center;border:1px solid var(--hair);background:var(--panel2)}
.mlog .well:focus-within{border-color:var(--red)}
.mlog .well input{border:none;background:none;width:118px;text-align:center;letter-spacing:.5px}
.mlog .well input:focus{outline:none}
.mlog .well .cal-open{border:none;border-left:1px solid var(--hair);background:none;padding:4px 8px}
.mlog .well.bad{border-color:var(--red);background:rgba(238,27,36,.08)}
.mlog .well.shake{animation:mlogshake .3s}
@keyframes mlogshake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.mlog .fieldmsg{color:var(--red);font-size:14px;max-width:260px;line-height:1.2}
.mlog .stat.pick{cursor:pointer;font-family:inherit}
.mlog .stat.pick:hover{border-color:var(--ink)}
.mlog .stat.pick.on{border-color:var(--ink);background:var(--panel2);box-shadow:inset 0 -2px 0 var(--red)}
.mlog .modal .mt .x{position:absolute;right:8px;top:6px;background:none;border:none;color:var(--dim);font-size:16px;padding:2px 6px}
.mlog .modal .mt .x:hover{color:var(--ink)}
.mlog .modal.cal{max-width:330px;border-color:var(--hair)}
.mlog .modal.cal .mt{position:relative;color:var(--ink)}
.mlog .cal-nav{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px}
.mlog .cal-nav .cal-month{font-size:18px}
.mlog .cal-nav button{padding:2px 10px}
.mlog .dow,.mlog .days{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;padding:0 10px}
.mlog .dow span{text-align:center;color:var(--dim);font-size:14px;padding-bottom:2px}
.mlog .days{padding-bottom:10px}
.mlog .day{background:none;border:1px solid transparent;color:var(--ink);font-family:inherit;font-size:17px;padding:5px 0;text-align:center;cursor:pointer}
.mlog .day:hover:not(:disabled){border-color:var(--ink)}
.mlog .day.empty{cursor:default}
.mlog .day.today{border-color:var(--hair);color:var(--amber)}
.mlog .day.on{background:var(--red);color:#fff;border-color:var(--red)}
.mlog .day:disabled{color:#3a3a3a;cursor:not-allowed;text-decoration:line-through}
.mlog .day.none{text-decoration:none;opacity:.35}
.mlog .calnote{padding:0 10px 8px;color:var(--dim);font-size:14px}
.mlog .modal .opt{display:flex;gap:8px;align-items:flex-start;margin-top:12px;padding-top:10px;border-top:1px solid var(--hair);cursor:pointer;font-size:16px}
.mlog .modal .opt input{margin-top:4px;accent-color:var(--red)}
.mlog .modal .opt .dim{color:var(--dim)}
.mlog .job{border:1px solid var(--hair);background:var(--panel);margin-bottom:4px}
.mlog .jh{display:flex;gap:10px;align-items:center;padding:5px 9px;cursor:pointer;font-size:16px}
.mlog .jh:hover{background:var(--panel2)}
.mlog .jh .t{color:var(--amber);min-width:70px}
.mlog .jh .u{color:#7dd3fc;min-width:110px}
.mlog .jh .c{color:var(--dim);min-width:52px;font-size:14px}
.mlog .jh .ttl{flex:1;color:var(--ink)}
.mlog .jh .d{color:var(--dim);font-size:14px}
.mlog .dot{width:9px;height:9px;flex:none}
.mlog .dot.ok{background:var(--green)}.mlog .dot.error{background:var(--red)}.mlog .dot.incomplete{background:var(--amber)}
.mlog .dot.quiet{background:#60a5fa}
.mlog .steps{border-top:1px solid var(--hair);background:#0d0d0d;padding:5px 9px 7px}
.mlog .ev{display:flex;gap:10px;font-size:15px;color:var(--dim);line-height:1.5}
.mlog .ev .st{color:#a3a3a3;min-width:80px}
.mlog .ev .lb{color:var(--ink)}
.mlog .why{color:var(--amber);background:rgba(240,180,41,.07);border:1px solid #78350f;
  padding:6px 9px;margin-bottom:6px;font-size:15.5px;line-height:1.5}
.mlog .why .closebtn{margin-top:6px;border-color:var(--amber);color:var(--amber);font-size:15px;padding:3px 9px}
.mlog .why .closebtn:hover{background:var(--amber);color:#06101f}
.mlog .why .closed{margin-top:6px;color:var(--green)}
.mlog .ev.error .lb,.mlog .ev.error .st{color:var(--red)}
.mlog .empty{border:1px dashed var(--hair);padding:20px;text-align:center;color:var(--dim);font-size:18px}
.mlog .note{border:1px solid var(--amber);color:var(--amber);padding:8px 10px;margin-bottom:8px;font-size:16px}
.mlog .note.match{border-color:#1e3a8a;color:#60a5fa}
.mlog .note.expired{display:flex;gap:10px;align-items:center;justify-content:space-between;border-color:var(--red);color:var(--red)}
.mlog .center{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
/* Own confirm dialog — window.confirm() cannot be themed and reads as the browser talking */
.mlog .modal-back{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:80;padding:16px}
.mlog .modal{border:2px solid var(--red);background:var(--panel);max-width:520px;width:100%;box-shadow:0 0 0 4px #000}
.mlog .modal .mt{font-size:9px;color:var(--red);padding:9px 12px;border-bottom:2px solid var(--hair);background:var(--panel2)}
.mlog .modal .mb{padding:12px;font-size:17px;line-height:1.55}
.mlog .modal .mb b{color:var(--amber)}
.mlog .modal .mb ul{margin:8px 0 0 18px;color:var(--dim)}
.mlog .modal .mb li{margin-bottom:2px}
.mlog .modal .ma{display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:2px solid var(--hair);background:var(--panel2)}
.mlog button.stop1{font-family:inherit;font-size:15px;color:var(--red);background:transparent;border:2px solid var(--red);border-radius:4px;padding:2px 8px;margin-right:10px;cursor:pointer}
.mlog button.stop1:hover:not(:disabled){background:var(--red);color:#fff}
.mlog button.stop1:disabled{opacity:.5;cursor:default}
.mlog .closedmini{color:var(--green);font-size:13px;margin-right:10px}
.mlog .ahnote{padding:6px 10px;border-bottom:1px solid var(--hair);color:var(--dim);font-size:13px;line-height:1.9}
.mlog .act td.who{color:var(--ink);font-size:14px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mlog .act tr.reason td{border-top:0;padding-top:0;padding-bottom:7px;color:var(--ink);font-size:14px;line-height:1.6}
.mlog button.openjob{font-family:inherit;font-size:13px;color:var(--amber);background:transparent;border:1px solid var(--amber);border-radius:4px;padding:1px 7px;margin-left:6px;cursor:pointer}
.mlog button.openjob:hover{background:var(--amber);color:#0a0a0a}
.mlog .act tr.detail td{border-top:0;padding:2px 0 10px}
.mlog .act .dh{color:var(--dim);font-size:13px;margin:2px 0 4px}
.mlog .act table.mini{width:auto;margin-bottom:6px}
.mlog .act table.mini td{border:0;padding:2px 14px 2px 0;font-size:14px;white-space:nowrap}
.mlog .act .caret{color:var(--dim)}
.mlog .closedwin{padding:7px 10px;border-bottom:1px solid var(--hair);background:rgba(240,180,41,.10);color:var(--amber);font-size:15px}
.mlog .openwin{padding:7px 10px;border-bottom:1px solid var(--hair);background:rgba(57,211,83,.08);color:var(--green);font-size:15px}
.mlog .act .stale{color:var(--amber)}
.mlog .wholine{padding:5px 10px 7px;color:var(--ink);font-size:15px;border-bottom:1px solid var(--hair)}
`;

function JobRow({
  job,
  canStop,
  onClose,
  nameFull,
  nameLong,
}: {
  job: LogJob;
  canStop: boolean;
  onClose: (traceId: string) => Promise<string>;
  nameFull: (user: string) => string;
  nameLong: (user: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState("");
  return (
    <div className="job">
      <div className="jh" onClick={() => setOpen((v) => !v)}>
        <span className={`dot ${job.outcome}`} title={OUTCOME_TH[job.outcome]} />
        <span className="t">{job.clock}</span>
        <span className="u" title={nameFull(job.user)}>{job.user}</span>
        <span className="c">{channelTH(job.channel)}</span>
        <span className="ttl">{titleShort(job.title)}</span>
        <span className="d">
          {/* Stopping a single job used to mean opening its row first, so on a
              day with one stuck job among a thousand it could not be found. */}
          {canStop && job.outcome === "incomplete" && !closed && (
            <button
              className="stop1"
              disabled={closing}
              title="ปิดงานค้างนี้อันเดียว (ไม่กระทบงานอื่น)"
              onClick={async (e) => {
                e.stopPropagation();
                setClosing(true);
                setClosed(await onClose(job.traceId));
                setClosing(false);
              }}
            >
              {closing ? "กำลังปิด…" : "■ หยุดงานนี้"}
            </button>
          )}
          {/* Say what happened on the row itself — the full message used to live
              inside the panel, so from a collapsed row the button just vanished. */}
          {closed && <span className="closedmini" title={closed}>ปิดแล้ว ✓</span>}
          {job.events.length} ขั้น · {(job.durationMs / 1000).toFixed(1)}s {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="steps">
          {/* Room to read it here, unlike the row above. */}
          <div className="wholine">
            👤 {nameLong(job.user)} <span className="dim">· {job.user}</span>
          </div>
          {job.diagnosis && (
            <div className="why">
              <div>⚠️ {job.diagnosis}</div>
              {canStop && !closed && (
                <button
                  className="closebtn"
                  disabled={closing}
                  onClick={async () => {
                    setClosing(true);
                    setClosed(await onClose(job.traceId));
                    setClosing(false);
                  }}
                >
                  {closing ? "กำลังปิด…" : "ปิดงานค้างนี้ + ปลดล็อกที่ค้างไว้"}
                </button>
              )}
              {closed && <div className="closed">{closed}</div>}
            </div>
          )}
          {job.events.map((e, i) => (
            <div key={i} className={`ev${e.status === "error" || e.step === "error" ? " error" : ""}`}>
              <span>{e.clock}</span>
              <span className="st">{STEP_TH[e.step] || e.step}</span>
              {/* the receive stage carries the job title, prefix and all */}
              <span className="lb">{e.label ? titleTH(e.label) : "—"}</span>
              <span>+{(e.ms / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LogView({
  getToken,
  reauth,
}: {
  getToken: () => Promise<string | null>;
  reauth: () => Promise<void>;
}) {
  const [date, setDate] = useState(bkkToday());
  const [user, setUser] = useState("");
  const [channel, setChannel] = useState("");
  const [q, setQ] = useState("");
  /** One job by id — the API can already fetch a single trace; the page could
   *  not ask for it, so "open the job that failed" had nowhere to go. */
  const [trace, setTrace] = useState("");
  /** Which activity row is open. */
  const [openAct, setOpenAct] = useState("");
  /** Which recurring job the user is about to stop, if any. */
  const [pauseAsk, setPauseAsk] = useState<{ key: string; label: string } | null>(null);
  const [outcome, setOutcome] = useState("");
  const [calOpen, setCalOpen] = useState(false);
  const [data, setData] = useState<LogResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelMsg, setCancelMsg] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expired, setExpired] = useState(false);
  const [denied, setDenied] = useState(false);
  const [live, setLive] = useState<LiveResp | null>(null);
  const [alsoPauseCron, setAlsoPauseCron] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const p = new URLSearchParams({ date });
      if (user) p.set("user", user);
      if (channel) p.set("channel", channel);
      if (q) p.set("q", q);
      if (trace) p.set("trace", trace);
      if (outcome) p.set("outcome", outcome);
      const r = await fetch(`/api/monitor/log?${p}`, { headers, cache: "no-store" });
      const d = await r.json();
      // The M365 session outlives nothing in particular — a tab left open all
      // morning gets a 401. Say that in words, with the way out.
      if (r.status === 401) {
        setExpired(true);
        setErr("");
        return;
      }
      // 403 is not a login problem — signing in again would change nothing.
      if (r.status === 403) {
        setDenied(true);
        setErr("");
        return;
      }
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setExpired(false);
      setDenied(false);
      setData(d as LogResp);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }, [getToken, date, user, channel, q, trace, outcome]);

  // Debounced: the user/keyword boxes change on every keystroke, and a query per
  // keystroke would hammer a table that holds every stage of every request.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  // "กำลังทำงานอยู่" — polled on its own short query every 5s, so the live view
  // stays current without re-reading the whole day. Stops while the session is
  // expired (every poll would 401) and while looking at a past day.
  useEffect(() => {
    if (expired || date !== bkkToday()) return; // panel is hidden in render too
    let alive = true;
    const poll = async () => {
      try {
        const token = await getToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetch("/api/monitor/log?live=1", { headers, cache: "no-store" });
        if (!alive) return;
        if (r.status === 401) {
          setExpired(true);
          return;
        }
        if (r.ok) setLive((await r.json()) as LiveResp);
      } catch {
        /* transient — the next tick retries */
      }
    };
    void poll();
    const id = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [getToken, date, expired]);

  // Esc closes the dialog — expected of anything that replaces window.confirm().
  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen]);

  // Stop the scheduler retrying today's morning deliveries. The confirm step is
  // our own dialog, not window.confirm() — the browser's box is chrome-styled,
  // shows the bare hostname, and cannot say this skips today for everyone.
  const cancelPending = useCallback(async () => {
    setConfirmOpen(false);
    setCancelling(true);
    setCancelMsg("");
    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const q = alsoPauseCron ? "&jobs=1" : "";
      const r = await fetch(`/api/monitor/cancel?scope=all&kind=both${q}`, { method: "POST", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setCancelMsg(
        `หยุดงานค้างแล้ว ${d.count} รายการ จากผู้ใช้ ${d.users} คน` +
          (d.paused ? ` · พักงานที่วนอยู่ ${d.paused.jobs.length} งานถึงเที่ยงคืน` : "")
      );
      void load();
    } catch (e) {
      setCancelMsg(`หยุดไม่สำเร็จ: ${String(e).slice(0, 200)}`);
    } finally {
      setCancelling(false);
    }
  }, [getToken, load, alsoPauseCron]);

  // A pause can now start on its own (a job that stopped finishing is paused by
  // the scheduler), so waiting until midnight is no longer an acceptable only
  // way out — undo has to be one click from the banner that announces it.
  const resumeCron = useCallback(async () => {
    setCancelling(true);
    setCancelMsg("");
    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch("/api/monitor/cancel?resume=1", { method: "POST", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setCancelMsg("เปิดงานที่หยุดไว้กลับแล้ว — รอบต่อไปจะทำงานตามปกติ");
      void load();
    } catch (e) {
      setCancelMsg(`เปิดกลับไม่สำเร็จ: ${String(e).slice(0, 200)}`);
    } finally {
      setCancelling(false);
    }
  }, [getToken, load]);

  const can = (p: string) => !!data?.perms?.includes(p);

  /**
   * Stop ONE recurring job until midnight. The red button at the top stops the
   * whole morning for everyone; this row is a single job, and there was no way
   * to say "just this one" — the only per-row button was for closing a dead run,
   * which does nothing for a job that is running and misbehaving.
   */
  const pauseJob = useCallback(
    async (key: string, label: string) => {
      setCancelling(true);
      setCancelMsg("");
      try {
        const token = await getToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetch(`/api/monitor/cancel?kind=none&jobs=${encodeURIComponent(key)}`, {
          method: "POST",
          headers,
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setCancelMsg(`หยุด “${label}” แล้ว — จะไม่ทำงานอีกจนถึงเที่ยงคืน (กด “เปิดกลับเลย” ได้ตลอด)`);
        void load();
      } catch (e) {
        setCancelMsg(`หยุดไม่สำเร็จ: ${String(e).slice(0, 200)}`);
      } finally {
        setCancelling(false);
      }
    },
    [getToken, load]
  );

  // The tables keep the mailbox name without the domain — short, unique, and
  // what this page has always shown. The directory name is stored as
  // "Supakorn Khamsuwan (กร ศุภกร ขำสุวรรณ)", too long for any column, so it
  // appears when a row is opened, where there is room to read it.

  /** The directory name in full — for anywhere there is room to read it. */
  const nameLong = (user: string) => data?.names?.[user] || user;
  /** Everything we know, for a tooltip. */
  const nameFull = (user: string) =>
    data?.names?.[user] ? `${data.names[user]} · ${user}` : user;
  // One dead job at a time: releases whatever locks it left and writes a closing
  // line into its own trace, so the history keeps its shape.
  const closeJob = useCallback(
    async (traceId: string): Promise<string> => {
      try {
        const token = await getToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetch("/api/monitor/close-job", {
          method: "POST",
          headers,
          body: JSON.stringify({ traceId }),
        });
        const d = await r.json();
        if (!r.ok) return `ปิดไม่สำเร็จ: ${d.error || r.status}`;
        void load();
        return d.note || `ปิดแล้ว · ปลดล็อก ${(d.released || []).join(", ") || "ไม่มี"}`;
      } catch (e) {
        return `ปิดไม่สำเร็จ: ${String(e).slice(0, 120)}`;
      }
    },
    [getToken, load]
  );

  const s = data?.summary;

  if (denied) {
    return (
      <div className="mlog">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="pix" style={{ fontSize: 14, color: "#ee1b24" }}>
            ไม่มีสิทธิ์ดู log
          </div>
          <div style={{ fontSize: 19, color: "#7c7c7c", maxWidth: 520, textAlign: "center" }}>
            หน้านี้เปิดให้เฉพาะผู้ที่ได้รับสิทธิ์ «ดู log» — ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์
          </div>
          <a className="link" href="/monitor">
            ← กลับห้องทำงาน
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mlog">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header>
        <h1 className="pix">
          AI ASSISTANT · <em>LOG ย้อนหลัง</em>
        </h1>
        <div className="spacer" />
        {can("admin") && (
          <a className="link" href="/monitor/admin">
            จัดการสิทธิ์
          </a>
        )}
        <a className="link" href="/monitor">
          ← กลับห้องทำงาน (สด)
        </a>
      </header>

      <div className="bar">
        <button onClick={() => setDate(shiftDate(date, -1))}>◀ วันก่อน</button>
        <DateField value={date} onChange={setDate} onOpenCal={() => setCalOpen(true)} />
        <button onClick={() => setDate(shiftDate(date, 1))} disabled={date >= bkkToday()}>
          วันถัดไป ▶
        </button>
        <button onClick={() => setDate(bkkToday())}>วันนี้</button>
        <input
          placeholder="ผู้ใช้ — ชื่อเล่นก็ได้ เช่น เอก"
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">ทุกช่องทาง</option>
          <option value="line">LINE</option>
          <option value="web">เว็บ</option>
          <option value="cron">ตั้งเวลา (งานที่รันเอง)</option>
          <option value="ops">ระบบ</option>
        </select>
        <input placeholder="ค้นในคำอธิบาย เช่น สรุปตารางเช้า" value={q} onChange={(e) => setQ(e.target.value)} />
        <button
          className={outcome === "problems" ? "on" : ""}
          onClick={() => setOutcome((v) => (v === "problems" ? "" : "problems"))}
        >
          เฉพาะที่มีปัญหา
        </button>
        <button onClick={() => void load()}>{loading ? "กำลังโหลด…" : "รีเฟรช"}</button>
        {trace && (
          <button onClick={() => setTrace("")} title="เลิกดูงานเดียว กลับไปดูทั้งวัน">
            ← เลิกดูงานเดียว
          </button>
        )}
        <div className="spacer" />
        {can("jobs.stop") && (
          <button className="danger" onClick={() => setConfirmOpen(true)} disabled={cancelling}>
            {cancelling ? "กำลังหยุด…" : "■ หยุดงานค้าง"}
          </button>
        )}
      </div>

      {calOpen && (
        <CalendarModal
          getToken={getToken}
          value={date}
          onPick={(iso) => {
            setDate(iso);
            setCalOpen(false);
          }}
          onClose={() => setCalOpen(false)}
        />
      )}

      {confirmOpen && (
        <div className="modal-back" onClick={() => setConfirmOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mt pix" id="confirm-title">
              ■ หยุดงานค้าง
            </div>
            <div className="mb">
              <p>
                หยุดงานค้าง<b> ของวันนี้ </b>ทั้งหมด — สรุปตารางเช้า + ข่าวเช้า ของผู้ใช้ทุกคน
              </p>
              <ul>
                <li>ระบบจะเลิกพยายามส่งซ้ำ จนถึงรอบพรุ่งนี้</li>
                <li>ไม่มีการลบข้อมูล ตั้งค่าเวลาส่งเดิมยังอยู่ครบ</li>
                <li>พิมพ์สั่งเองใน LINE เช่น «สรุปตารางเช้า» ยังใช้ได้ตามปกติ</li>
              </ul>
              <label className="opt">
                <input
                  type="checkbox"
                  checked={alsoPauseCron}
                  onChange={(e) => setAlsoPauseCron(e.target.checked)}
                />
                <span>
                  พักงานที่วนอยู่ด้วย — แจ้งนัดใหม่ / สรุปประชุม / เตือนนัดค้างตอบ
                  <span className="dim"> (ถึงเที่ยงคืน แล้วกลับมาเองอัตโนมัติ)</span>
                </span>
              </label>
            </div>
            <div className="ma">
              <button onClick={() => setConfirmOpen(false)}>ยกเลิก</button>
              <button className="danger" onClick={() => void cancelPending()} autoFocus>
                ยืนยัน หยุดงานค้าง
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelMsg && <div className="note">{cancelMsg}</div>}

      {expired && (
        <div className="note expired">
          <span>เซสชัน Microsoft 365 หมดอายุ — เข้าสู่ระบบใหม่เพื่อดู log ต่อ</span>
          <button className="danger" onClick={() => void reauth()}>
            เข้าสู่ระบบใหม่
          </button>
        </div>
      )}
      {pauseAsk && (
        <div className="modal-back" onClick={() => setPauseAsk(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mh">หยุด “{pauseAsk.label}” ?</div>
            <div className="mb">
              <b>งานนี้จะไม่ทำงานอีกจนถึงเที่ยงคืน</b> แล้วกลับมาเองรอบแรกของพรุ่งนี้ ·
              ระหว่างนี้จะไม่มีการแจ้งจากงานนี้เลย เช่น
              <ul>
                <li>แจ้งนัดใหม่ → มีคนนัดเข้ามาจะไม่มีใครบอก</li>
                <li>สรุปประชุม → ประชุมจบแล้วจะไม่มีสรุปส่งให้</li>
                <li>เตือนนัดค้างตอบ → คนที่ยังไม่ตอบจะไม่ถูกตาม</li>
              </ul>
              เปิดกลับได้ตลอดที่ปุ่ม “เปิดกลับเลย” ด้านบน
            </div>
            <div className="ma">
              <button onClick={() => setPauseAsk(null)}>ยกเลิก</button>
              <button
                className="danger"
                autoFocus
                onClick={() => {
                  const ask = pauseAsk;
                  setPauseAsk(null);
                  if (ask) void pauseJob(ask.key, ask.label);
                }}
              >
                หยุดงานนี้
              </button>
            </div>
          </div>
        </div>
      )}

      {!!data?.resolvedUsers?.length && (
        <div className="note match">
          ค้นชื่อเล่น “{user}” เจอใน M365: {data.resolvedUsers.map((r) => r.name).join(" · ")}
          {data.summary.users.length ? ` — มี log เฉพาะ ${data.summary.users.join(", ")}` : " — ยังไม่มี log ของวันนี้"}
        </div>
      )}
      {err && <div className="note">โหลดไม่สำเร็จ: {err}</div>}
      {data?.note && <div className="note">{data.note}</div>}
      {data?.truncated && <div className="note">วันนี้มี event เยอะมาก — แสดงเท่าที่ดึงได้ ลองกรองผู้ใช้/คำค้นเพิ่ม</div>}

      {live && !expired && date === bkkToday() && (
        <div className="act live">
          <div className="ah pix">
            <span className={live.running.length ? "beat" : ""}>●</span> กำลังทำงานอยู่ตอนนี้ ·{" "}
            {live.running.length} งาน <span className="dim">(อัปเดตทุก 5 วิ · {live.now})</span>
          </div>
          {live.paused && (
            <div className="paused">
              <span>
                ⏸ หยุดไว้: {live.paused.labels.join(" · ")}{" "}
                <span className="dim">
                  — ไม่ยิงซ้ำจนถึง {live.paused.untilClock} แล้วกลับมาทำงานเอง
                </span>
              </span>
              {can("jobs.stop") && (
                <button onClick={() => void resumeCron()} disabled={cancelling}>
                  {cancelling ? "กำลังเปิด…" : "▶ เปิดกลับเลย"}
                </button>
              )}
            </div>
          )}
          {live.running.length === 0 ? (
            <div className="idle">ว่าง — ไม่มีงานกำลังทำอยู่ในขณะนี้</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>งาน</th>
                  <th>ผู้ใช้</th>
                  <th>ขั้นที่ทำอยู่</th>
                  <th>เริ่ม</th>
                  <th>ผ่านไป</th>
                  {can("jobs.stop") && <th>หยุด</th>}
                </tr>
              </thead>
              <tbody>
                {live.running.map((r) => (
                  <tr key={r.traceId}>
                    <td className="n">{titleTH(r.title)}</td>
                    <td className="u" title={nameFull(r.user)}>
                      {r.user}
                    </td>
                    <td>
                      <span className="tag run">{STEP_TH[r.step] || r.step}</span>{" "}
                      <span className="dim">{r.stepLabel}</span>
                    </td>
                    <td className="dim">{r.startedClock}</td>
                    <td>{r.elapsedSec}s</td>
                    {can("jobs.stop") && (
                      <td>
                        <button
                          className="stop1"
                          disabled={cancelling}
                          title="ปิดงานนี้อันเดียว — ถ้ามันยังขยับอยู่ (ไม่ถึง 45 วิ) ระบบจะไม่ฆ่ากลางทาง"
                          onClick={async () => {
                            setCancelMsg(await closeJob(r.traceId));
                            void load();
                          }}
                        >
                          ■ หยุดงานนี้
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {s && (
        <div className="stats">
          {(
            [
              { key: "", cls: "", label: "งานทั้งหมด", n: s.traces, tip: "ดูทุกงานของวันนี้" },
              { key: "ok", cls: "ok", label: "สำเร็จ", n: s.ok ?? 0, tip: "ส่ง/ตอบถึงผู้ใช้เรียบร้อย" },
              {
                key: "quiet",
                cls: "quiet",
                label: "ไม่มีอะไรต้องส่ง",
                n: s.quiet ?? 0,
                tip: "ทำงานปกติ แต่รอบนั้นไม่มีอะไรต้องส่ง",
              },
              { key: "error", cls: "err", label: "ผิดพลาด", n: s.errors ?? 0, tip: "ล้มเหลว และรู้สาเหตุ" },
              {
                key: "incomplete",
                cls: "inc",
                label: "ไม่จบงาน",
                n: s.incomplete ?? 0,
                tip: "เริ่มแล้วแต่ไม่มีขั้นสุดท้าย และไม่ได้บันทึกว่าล้มเหลว",
              },
            ] as { key: string; cls: string; label: string; n: number; tip: string }[]
          ).map((c) => (
            <button
              key={c.key || "all"}
              className={`stat pick ${c.cls}${outcome === c.key ? " on" : ""}`}
              title={`${c.tip} — คลิกเพื่อกรอง`}
              onClick={() => setOutcome((v) => (v === c.key ? "" : c.key))}
            >
              {c.label} <b>{c.n}</b>
            </button>
          ))}
          <div className="stat" title="จำนวนขั้นตอนย่อยรวมทุกงาน (กรองไม่ได้)">
            ขั้นตอนรวม <b>{s.events}</b>
          </div>
          <div className="stat">ผู้ใช้: {s.users.join(", ") || "—"}</div>
        </div>
      )}

      {data?.today && !!data.activity?.length && (
        <div className="act">
          <div className="ah pix">
            งานตามเวลาที่ทำไปแล้ว · ย้อนหลัง {data.activityWindowMin ?? 30} นาที{" "}
            <span className="dim">(ประวัติ ไม่ใช่งานที่กำลังทำ · งานที่หยุดไว้จะไม่แสดง)</span>
          </div>
          {/* The rows below are the last half hour of history. When the
              scheduler is closed they are all in the past, and a row whose last
              run was 16 minutes ago read as a job still going. */}
          {data.cronWindow && !data.cronWindow.open && (
            <div className="closedwin">
              ⏸ <b>งานตั้งเวลาหยุดแล้ว</b> — ตอนนี้ {data.cronWindow.nowClock} อยู่นอกหน้าต่าง{" "}
              {data.cronWindow.from}–{data.cronWindow.to} · จะเริ่มรอบใหม่พรุ่งนี้{" "}
              {data.cronWindow.from} · <span className="dim">แถวด้านล่างคือรอบที่ทำไปแล้ว</span>
            </div>
          )}
          {data.cronWindow?.open && (
            <div className="openwin">
              ● <b>อยู่ในหน้าต่างเวลาทำงาน</b> {data.cronWindow.from}–{data.cronWindow.to} · ตอนนี้{" "}
              {data.cronWindow.nowClock}
            </div>
          )}
          {/* A polling job appearing here every few minutes is the system
              working, not a problem — which is not obvious from a list of
              repeated rows. Say which colour means what. */}
          <div className="ahnote">
            <span className="tag quiet">ไม่มีอะไรต้องส่ง</span> = ทำงานปกติ รอบนั้นไม่มีอะไรต้องแจ้ง (ต้องวนอยู่ตลอด
            ไม่ใช่ปัญหา) · <span className="tag err">ผิดพลาด</span> = รอบนั้นล้ม ·{" "}
            <span className="tag inc">ไม่จบงาน</span> = ค้างกลางทาง — ถ้าล้ม/ค้างซ้ำเกิน 30 นาที ระบบจะหยุดยิงซ้ำเอง
          </div>
          <table>
            <thead>
              <tr>
                <th>งาน</th>
                <th>รอบ</th>
                <th>คน</th>
                <th>ล่าสุด</th>
                <th>ผลลัพธ์</th>
              </tr>
            </thead>
            <tbody>
              {data.activity.map((a) => (
                // Clicking a row filters the list below to that job — the
                // summary was a dead end otherwise: it names a job and gives you
                // no way to see what actually happened in it.
                <React.Fragment key={a.title}>
                  <tr
                    className={`click${openAct === a.title ? " on" : ""}`}
                    title="คลิกเพื่อดูรายละเอียด — ใครบ้าง กี่รอบ ผลเป็นอย่างไร"
                    onClick={() => setOpenAct((v) => (v === a.title ? "" : a.title))}
                  >
                    <td className="n">
                      <span className="caret">{openAct === a.title ? "▾" : "▸"}</span>{" "}
                      {titleTH(a.title)}
                    </td>
                    <td>{a.runs}</td>
                    {/* A count of people could not be clicked into, and a mailbox
                        is not a name — so: names, and the rest behind "+N คน". */}
                    <td className="who" title={(a.userList || []).map(nameFull).join("\n")}>
                      {a.userList?.length
                        ? a.userList.slice(0, 3).join(", ") +
                          (a.users > 3 ? ` +${a.users - 3} คน` : "")
                        : a.users || "—"}
                    </td>
                    <td>
                      {a.lastClock}{" "}
                      <span className={a.lastAgoSec > 360 ? "stale" : "dim"}>
                        ({ago(a.lastAgoSec)}
                        {a.lastAgoSec > 360 ? " · ไม่ได้ทำงานแล้ว" : ""})
                      </span>
                    </td>
                    <td>
                      {a.ok > 0 && <span className="tag ok">สำเร็จ {a.ok}</span>}
                      {a.quiet > 0 && <span className="tag quiet">ไม่มีอะไรต้องส่ง {a.quiet}</span>}
                      {a.errors > 0 && <span className="tag err">ผิดพลาด {a.errors}</span>}
                      {a.incomplete > 0 && <span className="tag inc">ไม่จบงาน {a.incomplete}</span>}
                      {can("jobs.stop") && a.pauseKey && (
                        <button
                          className="stop1"
                          style={{ marginLeft: 10, marginRight: 0 }}
                          disabled={cancelling}
                          title="หยุดงานตั้งเวลานี้ไม่ให้ทำงานอีกจนถึงเที่ยงคืน"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPauseAsk({ key: a.pauseKey as string, label: titleTH(a.title) });
                          }}
                        >
                          ■ หยุดงานนี้
                        </button>
                      )}
                    </td>
                  </tr>
                  {openAct === a.title && (
                    <tr className="detail">
                      <td />
                      <td colSpan={4}>
                        <div className="dh">รายคน · {a.byUser?.length || 0} คน</div>
                        <table className="mini">
                          <tbody>
                            {(a.byUser || []).map((u) => (
                              <tr key={u.user}>
                                <td className="who" title={u.user}>
                                  {nameLong(u.user)}{" "}
                                  <span className="dim">· {u.user}</span>
                                </td>
                                <td>{u.runs} รอบ</td>
                                <td>
                                  {u.ok > 0 && <span className="tag ok">สำเร็จ {u.ok}</span>}
                                  {u.quiet > 0 && (
                                    <span className="tag quiet">ไม่มีอะไรต้องส่ง {u.quiet}</span>
                                  )}
                                  {u.errors > 0 && <span className="tag err">ผิดพลาด {u.errors}</span>}
                                  {u.incomplete > 0 && (
                                    <span className="tag inc">ไม่จบงาน {u.incomplete}</span>
                                  )}
                                </td>
                                <td className="dim">ล่าสุด {u.lastClock}</td>
                                <td>
                                  <button
                                    className="openjob"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setTrace("");
                                      setQ(a.title);
                                      setUser(u.user);
                                    }}
                                  >
                                    ดูงานของคนนี้ →
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <button
                          className="openjob"
                          onClick={(e) => {
                            e.stopPropagation();
                            setTrace("");
                            setUser("");
                            setQ(a.title);
                          }}
                        >
                          ดูทุกงานของ “{titleTH(a.title)}” ใน log →
                        </button>
                      </td>
                    </tr>
                  )}
                  {/* Why, in the same table. A red count with the reason a click
                      and a scroll away was the whole complaint. */}
                  {(a.reasons || []).map((r) => (
                    <tr key={a.title + r.label} className="reason">
                      <td />
                      <td colSpan={4}>
                        <span className="tag err">×{r.n}</span> {r.label}
                        <span className="dim">
                          {" "}
                          · {r.users.join(", ")} · ครั้งล่าสุด {r.clock}
                        </span>{" "}
                        <button
                          className="openjob"
                          onClick={(e) => {
                            e.stopPropagation();
                            setQ("");
                            setTrace(r.traceId);
                          }}
                        >
                          เปิดงานที่ล้ม →
                        </button>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && data && data.traces.length === 0 && (
        <div className="empty">ไม่มี log ตามเงื่อนไขนี้ในวันที่ {data.date}</div>
      )}

      {data && (data.matchedCount ?? 0) > (data.shownCount ?? 0) && (
        <div className="note">
          แสดง {data.shownCount} จาก {data.matchedCount} งาน — กรองผู้ใช้/คำค้นเพิ่มเพื่อดูส่วนที่เหลือ
        </div>
      )}

      {data?.traces.map((j) => (
        <JobRow
          key={j.traceId}
          job={j}
          canStop={can("jobs.stop")}
          onClose={closeJob}
          nameFull={nameFull}
          nameLong={nameLong}
        />
      ))}
    </div>
  );
}

function Gate() {
  const { account, login, ready, getToken, reauth } = useM365Auth();
  if (!ready) {
    return (
      <div className="mlog">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center pix" style={{ fontSize: 12 }}>
          กำลังโหลด…
        </div>
      </div>
    );
  }
  if (!account && !DEV) {
    return (
      <div className="mlog">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="pix" style={{ fontSize: 14, color: "#ee1b24" }}>
            AI ASSISTANT · LOG
          </div>
          <div style={{ fontSize: 20, color: "#7c7c7c" }}>ต้องล็อกอิน Microsoft 365 เพื่อดูหน้านี้</div>
          <button onClick={() => login()} style={{ fontSize: 18, padding: "6px 14px" }}>
            เข้าสู่ระบบ M365
          </button>
        </div>
      </div>
    );
  }
  return <LogView getToken={getToken} reauth={reauth} />;
}

export default function MonitorLogPage() {
  return (
    <M365AuthProvider>
      <Gate />
    </M365AuthProvider>
  );
}
