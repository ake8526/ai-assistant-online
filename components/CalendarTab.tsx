"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Loader2, MapPin, RefreshCw, Users, Video } from "lucide-react";
import { useM365Auth } from "@/components/M365AuthProvider";
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

type Resp = { events?: CalEvent[]; error?: string; reply?: string };

const DOW = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** "2026-08-31T13:00:00.0000000" — เวลาไทยตรง ๆ ไม่ต้องแปลงโซน */
function parts(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], day: `${m[1]}-${m[2]}-${m[3]}` };
}

function hhmm(iso: string) {
  const p = parts(iso);
  return p ? `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}` : "--:--";
}

/** โน้ตของนัดเปลี่ยนสีตามที่จัด: นอกสถานที่ = เขียว, ออนไลน์ = ฟ้า, คนเยอะ = ชมพู */
function tintFor(e: CalEvent) {
  const loc = (e.location || "").toLowerCase();
  if (e.joinUrl || loc.includes("teams")) return N_BLUE;
  if (e.attendees >= 8) return N_PINK;
  if (loc && !loc.includes("teams")) return N_GREEN;
  return N_YELLOW;
}

export default function CalendarTab({ initial }: { initial?: CalEvent[] | null }) {
  const { getToken, getGraphToken } = useM365Auth();
  const [events, setEvents] = useState<CalEvent[]>(initial || []);
  const [busy, setBusy] = useState(!initial);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await authedGet<Resp>("/api/calendar/events", getToken, getGraphToken);
      if (res.error) {
        setErr(res.reply || res.error);
        setEvents([]);
      } else {
        setEvents(res.events || []);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }, [getToken, getGraphToken]);

  // โหลดข้อมูลจริงตอนเปิดแท็บ — กฎนี้ไล่เข้าไปเห็น setState ใน load() แต่ทุกตัว
  // เกิดหลัง await แล้ว ไม่ได้ set ตรงใน effect body (React ยอมรับ fetch แบบนี้)
  useEffect(() => {
    // ฉากโหลดตอนเปิดแอปดึงมาให้แล้ว ไม่ต้องยิงซ้ำตอนเปิดแท็บ
    if (initial) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, initial]);

  /* กดปุ่มเอง — ขึ้น spinner ทันทีแล้วค่อยยิง */
  const reload = () => {
    setBusy(true);
    setErr("");
    void load();
  };

  /** 7 วันนับจากวันนี้ — สร้างจากวันของนัดแรกที่ API คืนช่วงมาให้ */
  const days = React.useMemo(() => {
    const today = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
      return { key, dom: d.getDate(), dow: DOW[d.getDay()], date: d };
    });
  }, []);

  const dayEvents = events
    .filter((e) => parts(e.start)?.day === days[sel]?.key)
    .sort((a, b) => a.start.localeCompare(b.start));

  const selDay = days[sel];
  const label = selDay
    ? selDay.date.toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long" })
    : "";

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-marker text-[19px]">ปฏิทินงานสัปดาห์นี้</h2>
        <button
          onClick={reload}
          disabled={busy}
          className={`${NOTE_SM} ${PRESS} ${N_BLUE} px-2.5 py-1 font-hand text-[15px] font-bold disabled:opacity-50 cursor-pointer`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "ซิงค์ M365"}
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {days.map((d, i) => {
          const has = events.some((e) => parts(e.start)?.day === d.key);
          const on = i === sel;
          return (
            <button
              key={d.key}
              onClick={() => setSel(i)}
              aria-pressed={on}
              className={`border-2 border-[#232122] rounded-[10px] py-1.5 flex flex-col items-center gap-0.5 cursor-pointer ${PRESS} ${
                on ? `${N_YELLOW} shadow-[2px_2px_0_#232122] -rotate-2` : "bg-white"
              }`}
            >
              <span className={`text-[10.5px] ${on ? "" : INK_2}`}>{d.dow}</span>
              <b className="font-hand text-[17px] leading-none">{d.dom}</b>
              <i
                className={`w-[5px] h-[5px] rounded-full ${
                  has ? "bg-[#232122]" : "bg-transparent"
                }`}
              />
            </button>
          );
        })}
      </div>

      <p className={`font-hand text-[16px] ${INK_2} -rotate-1`}>
        {label} · {dayEvents.length} รายการ
      </p>

      {err && (
        <BlankNote tint={N_PINK}>
          {err}
          <button
            onClick={reload}
            className={`${NOTE_SM} ${PRESS} bg-white mt-3 inline-flex items-center gap-1.5 px-3 py-1 text-[13px] font-note cursor-pointer`}
          >
            <RefreshCw className="w-3.5 h-3.5" /> ลองอีกครั้ง
          </button>
        </BlankNote>
      )}

      {!err && busy && <BlankNote>กำลังดึงปฏิทินจาก Microsoft 365…</BlankNote>}

      {!err && !busy && !dayEvents.length && <BlankNote>ไม่มีนัดหมาย — ว่างทั้งวันครับ</BlankNote>}

      <div className="flex flex-col gap-3.5">
        {dayEvents.map((e, i) => (
          <div key={e.id || i} className="flex gap-3 items-stretch">
            <div className="w-[52px] shrink-0 pt-3 text-right">
              <div className="font-hand text-[18px] font-bold leading-none">{hhmm(e.start)}</div>
              <small className={`font-hand text-[14px] ${INK_3}`}>{hhmm(e.end)}</small>
            </div>
            <div
              className={`${NOTE} ${FOLD} ${tintFor(e)} flex-1 min-w-0 p-3.5 flex flex-col gap-2 ${
                i % 2 ? "rotate-[0.5deg]" : "-rotate-[0.5deg]"
              }`}
            >
              <div className="font-semibold text-[14.5px] leading-snug">{e.subject}</div>
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
                <a
                  href={e.joinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`${NOTE_SM} ${PRESS} bg-white self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]`}
                >
                  <Video className="w-3.5 h-3.5" /> เข้าประชุม Teams
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
