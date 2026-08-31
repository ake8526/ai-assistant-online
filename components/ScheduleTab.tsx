"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, MapPin, RefreshCw, Users, Video } from "lucide-react";
import { useM365Auth } from "@/components/M365AuthProvider";
import { appBridge } from "@/components/useKeepAwake";
/** นัดหมายหนึ่งรายการจาก /api/calendar/events */
export type CalEvent = {
  id: string;
  subject: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  attendees: number;
  organizer: string;
  joinUrl: string;
  webLink: string;
};

/** ห้องประชุมหนึ่งห้องจาก /api/rooms/status */
export type Room = {
  email: string;
  name: string;
  busy: { start: string; end: string; label: string }[];
  free: boolean;
  loadPct: number;
  error: string;
};
import {
  authedGet,
  BlankNote,
  FOLD,
  INK_2,
  INK_3,
  N_BLUE,
  N_GREEN,
  N_PINK,
  N_YELLOW,
  NOTE,
  NOTE_SM,
  PRESS,
} from "@/components/noteStyles";

const DOW = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** ปี/เดือน/วัน (เดือนนับจาก 0 แบบ Date) → "2026-09-01" */
function keyOf(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** คีย์วันของวันนี้ รูปแบบเดียวกับที่ใช้เทียบกับ event */
function days0Key(): string {
  const d = new Date();
  return keyOf(d.getFullYear(), d.getMonth(), d.getDate());
}

/** คีย์เดือนสำหรับจำว่าดึงนัดของเดือนไหนมาแล้ว */
function monthKey(y: number, m: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** "2026-08-31T13:00:00.0000000" — เวลาไทยตรง ๆ ไม่ต้องแปลงโซน */
function dayKeyOf(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(iso || "");
  return m ? m[1] : "";
}
function hhmm(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso || "");
  return m ? `${m[1]}:${m[2]}` : "--:--";
}

/** "2026-08-31T13:00:00.0000000" → Date ตามเวลาไทยตรง ๆ ไม่ต้องแปลงโซน */
function wallDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

/**
 * นัดที่จบไปแล้ว — เอาไปทำเป็นสีเทาและขีดฆ่า
 *
 * ที่กำลังประชุมอยู่ยังไม่นับว่าจบ และนัดทั้งวันนับว่าจบเมื่อหมดวันไปแล้ว
 * ไม่ใช่ตอนเที่ยงคืนของเวลาเริ่ม
 */
function isPast(e: CalEvent, now: number): boolean {
  if (e.allDay) return dayKeyOf(e.start) < days0Key();
  const end = wallDate(e.end);
  return !!end && end.getTime() <= now;
}

/** สีโน้ตของนัด: ออนไลน์ = ฟ้า, คนเยอะ = ชมพู, มีสถานที่ = เขียว */
function tintFor(e: CalEvent): string {
  const loc = (e.location || "").toLowerCase();
  if (e.joinUrl || loc.includes("teams")) return N_BLUE;
  if (e.attendees >= 8) return N_PINK;
  if (loc) return N_GREEN;
  return N_YELLOW;
}

type View = "ev" | "rm";
/** ดูเป็นแถบ 7 วัน หรือเป็นตารางรายเดือน */
type Range = "week" | "month";

/**
 * ปฏิทินกับห้องประชุมอยู่หน้าเดียวกัน
 *
 * สองอย่างนี้ตอบคำถามเดียวกัน ("ว่างไหม") และเคยเป็นสองแท็บที่ต้องเด้งไปมา
 * ตอนนี้ใช้แถบวันร่วมกัน เลือกวันครั้งเดียวแล้วสลับดูได้ทั้งนัดของตัวเอง
 * และสถานะห้องของวันนั้น — สถานะห้องดึงตามวันที่เลือก ไม่ใช่วันนี้ตายตัว
 */
export default function ScheduleTab({
  events,
  busy,
  err,
  onReload,
  initialRooms,
  initialRoomsDate,
  onAsk,
}: {
  /** นัดทั้งหมดมาจากเปลือกแอป — ที่นี่ไม่ดึงเอง จึงอัปเดทเองได้หลังจองเสร็จ */
  events: CalEvent[] | null;
  busy: boolean;
  err: string;
  onReload: () => void;
  /** สถานะห้องที่ฉากโหลดตอนเปิดแอปดึงมาแล้ว */
  initialRooms?: Room[] | null;
  /** วันที่ของ initialRooms ตามที่เซิร์ฟเวอร์ตอบมา ("2026-09-01") */
  initialRoomsDate?: string;
  onAsk: (t: string) => void;
}) {
  const { getToken, getGraphToken } = useM365Auth();
  /** วันที่เลือกเก็บเป็นคีย์วัน ไม่ใช่ดัชนีของแถบ 7 วัน — โหมดเดือนเลือกวันไหนก็ได้ */
  const [selKey, setSelKey] = useState(days0Key);
  const [range, setRange] = useState<Range>("week");
  /** ข้อความสั้น ๆ ตอนกดปุ่มประชุมบนแอปรุ่นเก่าที่ยังส่งต่อให้ Teams ไม่ได้ */
  const [joinNote, setJoinNote] = useState("");
  const [view, setView] = useState<View>("ev");

  /* เวลาปัจจุบันเดินทุกนาที นัดที่เพิ่งเลยเวลาจะกลายเป็นเทาเองโดยไม่ต้องกดอะไร
     และแถบ 7 วันเลื่อนไปวันใหม่เองเมื่อเลยเที่ยงคืน แม้แอปจะเปิดค้างอยู่ */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const days = useMemo(() => {
    const t = new Date(now);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i);
      return {
        key: keyOf(d.getFullYear(), d.getMonth(), d.getDate()),
        dom: d.getDate(),
        dow: DOW[d.getDay()],
      };
    });
  }, [now]);

  // เลยเที่ยงคืนแล้ววันที่เลือกไว้หลุดออกไปข้างหลังแถบ — เลื่อนมาที่วันนี้ให้เอง
  useEffect(() => {
    if (range !== "week" || !days[0] || selKey >= days[0].key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelKey(days[0].key);
  }, [range, days, selKey]);

  const selDate = useMemo(() => {
    const [y, m, d] = selKey.split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }, [selKey]);
  const dayLabel = selDate.toLocaleDateString("th-TH", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  /* ---------- ตารางรายเดือน ---------- */
  const [month, setMonth] = useState(() => {
    const t = new Date();
    return { y: t.getFullYear(), m: t.getMonth() };
  });
  const [monthEvents, setMonthEvents] = useState<CalEvent[] | null>(null);
  const [busyMo, setBusyMo] = useState(false);
  const [errMo, setErrMo] = useState("");
  const [monthLoaded, setMonthLoaded] = useState("");

  const loadMonth = useCallback(
    async (y: number, m: number) => {
      const last = new Date(y, m + 1, 0).getDate();
      const from = `${keyOf(y, m, 1)}T00:00:00`;
      const to = `${keyOf(y, m, last)}T23:59:59`;
      try {
        const res = await authedGet<{ events?: CalEvent[]; error?: string; reply?: string }>(
          `/api/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          getToken,
          getGraphToken
        );
        if (res.error) {
          setErrMo(res.reply || res.error);
        } else {
          setMonthEvents(res.events || []);
          setErrMo("");
        }
        setMonthLoaded(monthKey(y, m));
      } catch (e) {
        setErrMo((e as Error).message);
      }
      setBusyMo(false);
    },
    [getToken, getGraphToken]
  );

  // เดือนหนึ่งกินหลายสิบรายการ ดึงเมื่อเปิดดูจริงและเมื่อเปลี่ยนเดือนเท่านั้น
  useEffect(() => {
    if (range !== "month" || monthKey(month.y, month.m) === monthLoaded || busyMo) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusyMo(true);
    void loadMonth(month.y, month.m);
  }, [range, month, monthLoaded, busyMo, loadMonth]);

  /* นัดจากเปลือกแอปเป็นของสด (อัปเดทเองทันทีหลังจอง) จึงทับของเดือนที่ดึงมา */
  const allEvents = useMemo(() => {
    const byId = new Map<string, CalEvent>();
    for (const e of monthEvents || []) byId.set(e.id || `${e.start}|${e.subject}`, e);
    for (const e of events || []) byId.set(e.id || `${e.start}|${e.subject}`, e);
    return [...byId.values()];
  }, [events, monthEvents]);

  /** จำนวนนัดต่อวัน — จุดใต้ตัวเลขวันทั้งในแถบ 7 วันและในตารางเดือน */
  const perDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of allEvents) {
      const k = dayKeyOf(e.start);
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [allEvents]);

  /** ช่องของตารางเดือน — ช่องเติมหัวท้ายให้ครบสัปดาห์เป็น null */
  const cells = useMemo(() => {
    const lead = new Date(month.y, month.m, 1).getDay();
    const last = new Date(month.y, month.m + 1, 0).getDate();
    const out: (number | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= last; d++) out.push(d);
    while (out.length % 7) out.push(null);
    return out;
  }, [month]);

  const monthLabel = new Date(month.y, month.m, 1).toLocaleDateString("th-TH", {
    month: "long",
    year: "numeric",
  });

  /* เปลี่ยนเดือนแล้วเลือกวันแรกของเดือนนั้นให้เลย (วันนี้ถ้ากลับมาเดือนปัจจุบัน)
     แผงข้างล่างจึงเดินตามเดือนที่กำลังดู ไม่ค้างอยู่ที่วันของเดือนก่อน */
  const goMonth = (delta: number) => {
    const d = new Date(month.y, month.m + delta, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const t = new Date(now);
    setMonth({ y, m });
    setSelKey(y === t.getFullYear() && m === t.getMonth() ? days0Key() : keyOf(y, m, 1));
  };

  /* สลับโหมด: เข้าโหมดเดือนให้เปิดที่เดือนของวันที่เลือกอยู่ ออกมาโหมด 7 วัน
     แล้ววันที่เลือกไม่อยู่ในแถบ ให้กลับมาที่วันนี้ ไม่ใช่ปล่อยให้ไม่มีวันไหนติด */
  const pickRange = (r: Range) => {
    setRange(r);
    if (r === "month") {
      setMonth({ y: selDate.getFullYear(), m: selDate.getMonth() });
    } else if (days[0] && days[6] && (selKey < days[0].key || selKey > days[6].key)) {
      setSelKey(days0Key());
    }
  };

  /* ---------- ห้องประชุมของวันที่เลือก ---------- */
  const [rooms, setRooms] = useState<Room[]>(initialRooms || []);
  const [busyRm, setBusyRm] = useState(false);
  const [errRm, setErrRm] = useState("");
  /* ห้องที่ฉากโหลดดึงมาผูกกับวันที่เซิร์ฟเวอร์ตอบว่าเป็นของวันไหน ไม่ใช่ "วันนี้"
     ลอย ๆ — เปิดแอปค้างข้ามเที่ยงคืนแล้วกดเข้าแท็บนี้ เคยเห็นสถานะห้องของเมื่อวาน
     อยู่ใต้หัวเรื่องของวันนี้ (เจอจริง 1 ก.ย. 2026) */
  const [loadedFor, setLoadedFor] = useState(
    initialRooms && initialRoomsDate ? initialRoomsDate.slice(0, 10) : ""
  );

  const loadRooms = useCallback(
    async (dayKey: string) => {
      try {
        const res = await authedGet<{ rooms?: Room[]; error?: string; reply?: string }>(
          `/api/rooms/status?date=${encodeURIComponent(dayKey + "T00:00:00")}`,
          getToken,
          getGraphToken
        );
        if (res.error) {
          setErrRm(res.reply || res.error);
          setRooms([]);
        } else {
          setRooms(res.rooms || []);
          setErrRm("");
        }
        setLoadedFor(dayKey);
      } catch (e) {
        setErrRm((e as Error).message);
      }
      setBusyRm(false);
    },
    [getToken, getGraphToken]
  );

  // ดึงสถานะห้องเมื่อเปิดดูจริง และเมื่อเปลี่ยนวัน — ไม่ดึงล่วงหน้าทุกวันโดยเปล่าประโยชน์
  useEffect(() => {
    if (view !== "rm" || !selKey || selKey === loadedFor || busyRm) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusyRm(true);
    void loadRooms(selKey);
  }, [view, selKey, loadedFor, busyRm, loadRooms]);

  const dayEvents = allEvents
    .filter((e) => dayKeyOf(e.start) === selKey)
    .sort((a, b) => a.start.localeCompare(b.start));

  /* โหมดเดือนต้องรอนัดของเดือนมาก่อน ไม่งั้นวันที่มีนัดจะขึ้นว่างทั้งวันอยู่ครู่หนึ่ง */
  const loadingEv =
    (events === null && !err) || (range === "month" && monthEvents === null && !errMo);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-marker text-[19px]">ตารางและห้องประชุม</h2>
        <button
          /* เดิมปุ่มนี้ดึงแต่นัดหมาย สถานะห้องที่ค้างจึงล้างไม่ได้เลยจากหน้านี้ */
          onClick={() => {
            setLoadedFor("");
            setMonthLoaded("");
            onReload();
          }}
          disabled={busy}
          className={`${NOTE_SM} ${PRESS} ${N_BLUE} px-2.5 py-1 font-hand text-[15px] font-bold disabled:opacity-50 cursor-pointer`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "ซิงค์ M365"}
        </button>
      </div>

      {!!joinNote && (
        <div className={`${NOTE_SM} ${N_YELLOW} px-3 py-2 text-[12px] flex items-start gap-2`}>
          <span className="flex-1">
            {joinNote}
            <br />
            <span className={INK_2}>อัปเดตแอปเป็นรุ่น 3.4 แล้วปุ่มนี้จะเปิดแอป Teams ให้เอง</span>
          </span>
          <button onClick={() => setJoinNote("")} className="shrink-0 underline cursor-pointer">
            ปิด
          </button>
        </div>
      )}

      {/* ดูเป็นแถบ 7 วัน หรือกางเป็นตารางเดือน — วันที่เลือกเดินไปกับทั้งสองโหมด */}
      <div className="flex items-center gap-2">
        <div className="flex border-2 border-[var(--nb-ink)] rounded-[10px] overflow-hidden shadow-[2px_2px_0_var(--nb-ink)] shrink-0">
          {(
            [
              ["week", "7 วัน"],
              ["month", "เดือน"],
            ] as const
          ).map(([r, label], i) => (
            <button
              key={r}
              onClick={() => pickRange(r)}
              aria-pressed={range === r}
              className={`px-3 py-1 font-hand text-[15px] font-bold cursor-pointer ${PRESS} ${
                i ? "border-l-2 border-[var(--nb-ink)]" : ""
              } ${range === r ? N_YELLOW : "bg-[var(--nb-surface)]"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {range === "month" && (
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={() => goMonth(-1)}
              aria-label="เดือนก่อน"
              className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] p-1 cursor-pointer`}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="font-hand text-[16px] font-bold text-center min-w-[104px]">
              {monthLabel}
            </span>
            <button
              onClick={() => goMonth(1)}
              aria-label="เดือนถัดไป"
              className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] p-1 cursor-pointer`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {range === "week" ? (
        <div className="grid grid-cols-7 gap-1.5">
          {days.map((d) => {
            const has = !!perDay.get(d.key);
            const on = d.key === selKey;
            return (
              <button
                key={d.key}
                onClick={() => setSelKey(d.key)}
                aria-pressed={on}
                className={`border-2 border-[var(--nb-ink)] rounded-[10px] py-1.5 flex flex-col items-center gap-0.5 cursor-pointer ${PRESS} ${
                  on ? `${N_YELLOW} shadow-[2px_2px_0_var(--nb-ink)] -rotate-2` : "bg-[var(--nb-surface)]"
                }`}
              >
                <span className={`text-[10.5px] ${on ? "" : INK_2}`}>{d.dow}</span>
                <b className="font-hand text-[17px] leading-none">{d.dom}</b>
                <i className={`w-[5px] h-[5px] rounded-full ${has ? "bg-[var(--nb-ink)]" : "bg-transparent"}`} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className={`${NOTE} bg-[var(--nb-surface)] p-2.5`}>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DOW.map((n) => (
              <div key={n} className={`text-center text-[10.5px] ${INK_2}`}>
                {n}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => {
              if (!d) return <div key={`pad${i}`} />;
              const key = keyOf(month.y, month.m, d);
              const on = key === selKey;
              const isToday = key === days0Key();
              /* จุดบอกว่าวันนั้นมีนัดกี่รายการ เกินสามก็สามจุด — พอให้กวาดตาเห็น */
              const dots = Math.min(perDay.get(key) || 0, 3);
              return (
                <button
                  key={key}
                  onClick={() => setSelKey(key)}
                  aria-pressed={on}
                  aria-current={isToday ? "date" : undefined}
                  className={`aspect-square rounded-[9px] border-2 flex flex-col items-center justify-center gap-1 cursor-pointer ${PRESS} ${
                    on
                      ? `${N_YELLOW} border-[var(--nb-ink)] shadow-[2px_2px_0_var(--nb-ink)] -rotate-2`
                      : isToday
                        ? "bg-[var(--nb-surface)] border-[var(--nb-ink)] border-dashed"
                        : "bg-[var(--nb-surface)] border-transparent"
                  }`}
                >
                  <b className={`font-hand text-[16px] leading-none ${on || isToday ? "" : INK_2}`}>
                    {d}
                  </b>
                  <span className="flex items-center gap-[3px] h-[4px]">
                    {Array.from({ length: dots }, (_, k) => (
                      <i key={k} className="w-[4px] h-[4px] rounded-full bg-[var(--nb-ink)]" />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
          {busyMo && (
            <p className={`mt-2 text-center text-[11.5px] ${INK_2}`}>กำลังดึงนัดของเดือนนี้…</p>
          )}
          {!!errMo && (
            <p className={`mt-2 text-center text-[11.5px] ${INK_2}`}>ดึงนัดของเดือนไม่ได้: {errMo}</p>
          )}
        </div>
      )}

      {/* สลับดูนัดหมาย / ห้องว่าง ของวันเดียวกัน */}
      <div className="flex border-2 border-[var(--nb-ink)] rounded-[12px] overflow-hidden shadow-[2px_2px_0_var(--nb-ink)]">
        {(
          [
            ["ev", "นัดหมาย", String(dayEvents.length)],
            ["rm", "ห้องว่าง", rooms.length ? String(rooms.filter((r) => r.free).length) : ""],
          ] as const
        ).map(([v, label, count], i) => (
          <button
            key={v}
            onClick={() => setView(v)}
            aria-pressed={view === v}
            className={`flex-1 py-1.5 text-[12.5px] cursor-pointer ${i === 0 ? "border-r-2 border-[var(--nb-ink)]" : ""} ${
              view === v ? `${N_BLUE} font-semibold` : "bg-[var(--nb-surface)]"
            }`}
          >
            {label} {count && <span className="font-hand">{count}</span>}
          </button>
        ))}
      </div>

      {view === "ev" && (
        <>
          <p className={`font-hand text-[16px] ${INK_2} -rotate-1`}>
            {dayLabel} · {dayEvents.length} รายการ
          </p>

          {err && (
            <BlankNote tint={N_PINK}>
              {err}
              <button
                onClick={onReload}
                className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] mt-3 inline-flex items-center gap-1.5 px-3 py-1 text-[13px] font-note cursor-pointer`}
              >
                <RefreshCw className="w-3.5 h-3.5" /> ลองอีกครั้ง
              </button>
            </BlankNote>
          )}
          {!err && loadingEv && <BlankNote>กำลังดึงปฏิทินจาก Microsoft 365…</BlankNote>}
          {!err && !loadingEv && !dayEvents.length && (
            <BlankNote>ไม่มีนัดหมาย — ว่างทั้งวันครับ</BlankNote>
          )}

          <div className="flex flex-col gap-3.5">
            {dayEvents.map((e, i) => {
              const past = isPast(e, now);
              return (
              <div key={e.id || i} className="flex gap-3 items-stretch">
                <div className={`w-[52px] shrink-0 pt-3 text-right ${past ? INK_3 : ""}`}>
                  <div className={`font-hand text-[18px] font-bold leading-none ${past ? "line-through" : ""}`}>
                    {hhmm(e.start)}
                  </div>
                  <small className={`font-hand text-[14px] ${INK_3}`}>{hhmm(e.end)}</small>
                </div>
                <div
                  className={`${NOTE} ${FOLD} ${past ? "bg-[var(--nb-surface)] opacity-55" : tintFor(e)} flex-1 min-w-0 p-3.5 flex flex-col gap-2 ${
                    i % 2 ? "rotate-[0.5deg]" : "-rotate-[0.5deg]"
                  }`}
                >
                  <div
                    className={`font-semibold text-[14.5px] leading-snug ${
                      past ? `line-through decoration-2 ${INK_2}` : ""
                    }`}
                  >
                    {e.subject}
                  </div>
                  <div className={`flex flex-wrap gap-x-3 gap-y-1 text-[12px] ${INK_2}`}>
                    {e.location && (
                      <span className="flex items-center gap-1 min-w-0">
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{e.location}</span>
                      </span>
                    )}
                    {e.attendees > 0 && (
                      <span className="flex items-center gap-1">
                        <Users className="w-3.5 h-3.5" />
                        {e.attendees} ท่าน
                      </span>
                    )}
                  </div>
                  {e.joinUrl && (
                    /* หน้าเว็บไม่สร้างลิงก์ intent:// เอง — เรียกสะพานของแอปให้เปิดแอป Teams
                       และเช็กก่อนเสมอว่ามีเมธอดนี้จริง — หน้าเว็บอัปเดทเองทันที แต่ APK
                       ต้องลงด้วยมือ การส่ง intent:// ไปให้แอปรุ่นเก่าจึงขึ้น ERR_UNKNOWN_URL_SCHEME */
                    <a
                      href={e.joinUrl}
                      onClick={(ev) => {
                        const bridge = appBridge();
                        if (!bridge) return; // บนเบราว์เซอร์ — ลิงก์ทำงานตามปกติ
                        ev.preventDefault();
                        if (bridge.openMeeting) {
                          bridge.openMeeting(e.joinUrl);
                          return;
                        }
                        // แอปรุ่นเก่า: หน้า Teams เว็บจะเด้งไป msteams:// เอง ซึ่ง WebView
                        // อ่านไม่ออก กลายเป็นหน้า error ค้าง — อย่าพาไปเจออีก
                        // ต้องขึ้นข้อความเสมอ ไม่ว่าคัดลอกได้หรือไม่ — กดแล้วเงียบคืออาการที่แย่สุด
                        const ok = "คัดลอกลิงก์ประชุมแล้ว — เปิดแอป Teams แล้ววางลิงก์ได้เลย";
                        const fail = "คัดลอกลิงก์อัตโนมัติไม่ได้ — เปิดนัดนี้จาก Outlook หรือ Teams แทน";
                        if (navigator.clipboard?.writeText) {
                          navigator.clipboard
                            .writeText(e.joinUrl)
                            .then(() => setJoinNote(ok))
                            .catch(() => setJoinNote(fail));
                        } else {
                          setJoinNote(fail);
                        }
                      }}
                      target={appBridge() ? undefined : "_blank"}
                      rel="noreferrer"
                      className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]`}
                    >
                      <Video className="w-3.5 h-3.5" /> เข้าประชุม Teams
                    </a>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        </>
      )}

      {view === "rm" && (
        <>
          <p className={`font-hand text-[16px] ${INK_2} -rotate-1`}>
            {dayLabel} · แถบแรเงา = ช่วงที่ถูกจองแล้ว
          </p>

          {errRm && (
            <BlankNote tint={N_PINK}>
              {errRm}
              <button
                onClick={() => {
                  setLoadedFor("");
                  setErrRm("");
                }}
                className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] mt-3 inline-flex items-center gap-1.5 px-3 py-1 text-[13px] font-note cursor-pointer`}
              >
                <RefreshCw className="w-3.5 h-3.5" /> ลองอีกครั้ง
              </button>
            </BlankNote>
          )}
          {!errRm && busyRm && <BlankNote>กำลังเช็คสถานะห้อง…</BlankNote>}
          {!errRm && !busyRm && !rooms.length && (
            <BlankNote>ยังไม่มีห้องประชุมในระบบ — เพิ่มได้ที่ lib/meetingRooms.ts</BlankNote>
          )}

          <div className="flex flex-col gap-3.5">
            {rooms.map((r, i) => (
              <div
                key={r.email}
                className={`${NOTE} ${FOLD} ${r.free ? N_GREEN : N_PINK} p-3.5 flex flex-col gap-2.5 ${
                  i % 2 ? "rotate-[0.5deg]" : "-rotate-[0.5deg]"
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-[14.5px] leading-snug">{r.name}</div>
                    <div className={`text-[12px] truncate ${INK_2}`}>{r.email}</div>
                  </div>
                  <span className={`${NOTE_SM} bg-[var(--nb-surface)] px-2 py-0.5 font-hand text-[15px] font-bold shrink-0`}>
                    {r.free ? "ว่าง" : "ไม่ว่าง"}
                  </span>
                </div>

                <div>
                  <div className="flex items-baseline justify-between text-[12px]">
                    <span className={INK_2}>
                      {r.free ? "ว่างตลอดทั้งวัน" : `ไม่ว่าง ${r.busy.map((b) => b.label).join(" · ")}`}
                    </span>
                    <span className="font-hand text-[16px] font-bold">{r.loadPct}%</span>
                  </div>
                  <div className="h-[13px] mt-1.5 border-2 border-[var(--nb-ink)] rounded-[8px] bg-[var(--nb-surface)] overflow-hidden">
                    <div
                      className="h-full transition-[width] duration-700"
                      style={{
                        width: `${r.loadPct}%`,
                        borderRight: r.loadPct ? "2px solid var(--nb-ink)" : "none",
                        backgroundImage:
                          "repeating-linear-gradient(45deg,var(--nb-ink) 0 2px,transparent 2px 7px)",
                      }}
                    />
                  </div>
                </div>

                {r.error ? (
                  <p className={`text-[12px] ${INK_2}`}>อ่านสถานะไม่ได้: {r.error}</p>
                ) : (
                  <button
                    onClick={() => onAsk(`จอง${r.name} ${dayLabel}`)}
                    className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] self-start px-3 py-1.5 text-[13px] cursor-pointer`}
                  >
                    จองห้องนี้
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
