"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, MapPin, RefreshCw, Users, Video } from "lucide-react";
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

/** คีย์วันของวันนี้ รูปแบบเดียวกับที่ใช้เทียบกับ event */
function days0Key(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  onAsk,
}: {
  /** นัดทั้งหมดมาจากเปลือกแอป — ที่นี่ไม่ดึงเอง จึงอัปเดทเองได้หลังจองเสร็จ */
  events: CalEvent[] | null;
  busy: boolean;
  err: string;
  onReload: () => void;
  /** สถานะห้องของ "วันนี้" ที่ฉากโหลดตอนเปิดแอปดึงมาแล้ว */
  initialRooms?: Room[] | null;
  onAsk: (t: string) => void;
}) {
  const { getToken, getGraphToken } = useM365Auth();
  const [sel, setSel] = useState(0);
  /** ข้อความสั้น ๆ ตอนกดปุ่มประชุมบนแอปรุ่นเก่าที่ยังส่งต่อให้ Teams ไม่ได้ */
  const [joinNote, setJoinNote] = useState("");
  const [view, setView] = useState<View>("ev");

  const days = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
      return { key, dom: d.getDate(), dow: DOW[d.getDay()], date: d };
    });
  }, []);

  /* ---------- ห้องประชุมของวันที่เลือก ---------- */
  const [rooms, setRooms] = useState<Room[]>(initialRooms || []);
  const [busyRm, setBusyRm] = useState(false);
  const [errRm, setErrRm] = useState("");
  // ห้องที่ฉากโหลดดึงมาเป็นของวันนี้ ถือว่าโหลดวันแรกไว้แล้ว ไม่ต้องยิงซ้ำ
  const [loadedFor, setLoadedFor] = useState(initialRooms ? days0Key() : "");

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
    const key = days[sel]?.key;
    if (view !== "rm" || !key || key === loadedFor || busyRm) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusyRm(true);
    void loadRooms(key);
  }, [view, sel, days, loadedFor, busyRm, loadRooms]);

  // เวลาปัจจุบันเดินทุกนาที นัดที่เพิ่งเลยเวลาจะกลายเป็นเทาเองโดยไม่ต้องกดอะไร
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const dayEvents = (events || [])
    .filter((e) => dayKeyOf(e.start) === days[sel]?.key)
    .sort((a, b) => a.start.localeCompare(b.start));

  const selDay = days[sel];
  const dayLabel = selDay
    ? selDay.date.toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long" })
    : "";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-marker text-[19px]">ตารางและห้องประชุม</h2>
        <button
          onClick={onReload}
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

      <div className="grid grid-cols-7 gap-1.5">
        {days.map((d, i) => {
          const has = (events || []).some((e) => dayKeyOf(e.start) === d.key);
          const on = i === sel;
          return (
            <button
              key={d.key}
              onClick={() => setSel(i)}
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
          {!err && events === null && <BlankNote>กำลังดึงปฏิทินจาก Microsoft 365…</BlankNote>}
          {!err && events !== null && !dayEvents.length && (
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
