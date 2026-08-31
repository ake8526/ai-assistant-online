"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
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
  NOTE,
  NOTE_SM,
  PRESS,
} from "@/components/noteStyles";

export type Room = {
  email: string;
  name: string;
  busy: { start: string; end: string; label: string }[];
  free: boolean;
  loadPct: number;
  error: string;
};

type Resp = { rooms?: Room[]; error?: string; reply?: string };

export default function RoomsTab({
  onAsk,
  initial,
}: {
  onAsk: (text: string) => void;
  initial?: Room[] | null;
}) {
  const { getToken, getGraphToken } = useM365Auth();
  const [rooms, setRooms] = useState<Room[]>(initial || []);
  const [busy, setBusy] = useState(!initial);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await authedGet<Resp>("/api/rooms/status", getToken, getGraphToken);
      if (res.error) {
        setErr(res.reply || res.error);
        setRooms([]);
      } else {
        setRooms(res.rooms || []);
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

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-marker text-[19px]">ห้องประชุม</h2>
        <button
          onClick={reload}
          disabled={busy}
          className={`${NOTE_SM} ${PRESS} ${N_BLUE} px-2.5 py-1 font-hand text-[15px] font-bold disabled:opacity-50 cursor-pointer`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "เช็คใหม่"}
        </button>
      </div>

      <p className={`font-hand text-[16px] ${INK_3} -rotate-1`}>
        สถานะจริงจาก Outlook Room Mailbox · แถบแรเงา = ช่วงที่ถูกจองแล้ววันนี้
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

      {!err && busy && <BlankNote>กำลังเช็คสถานะห้อง…</BlankNote>}

      {!err && !busy && !rooms.length && (
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
              <span className={`${NOTE_SM} bg-white px-2 py-0.5 font-hand text-[15px] font-bold shrink-0`}>
                {r.free ? "ว่าง" : "ไม่ว่าง"}
              </span>
            </div>

            <div>
              <div className="flex items-baseline justify-between text-[12px]">
                <span className={INK_2}>
                  {r.free
                    ? "ว่างตลอดทั้งวัน"
                    : `ไม่ว่าง ${r.busy.map((b) => b.label).join(" · ")}`}
                </span>
                <span className="font-hand text-[16px] font-bold">{r.loadPct}%</span>
              </div>
              <div className="h-[13px] mt-1.5 border-2 border-[#232122] rounded-[8px] bg-white overflow-hidden">
                <div
                  className="h-full border-r-2 border-[#232122] transition-[width] duration-700"
                  style={{
                    width: `${r.loadPct}%`,
                    borderRightWidth: r.loadPct ? 2 : 0,
                    backgroundImage:
                      "repeating-linear-gradient(45deg,#232122 0 2px,transparent 2px 7px)",
                  }}
                />
              </div>
            </div>

            {r.error ? (
              <p className={`text-[12px] ${INK_2}`}>อ่านสถานะไม่ได้: {r.error}</p>
            ) : (
              <button
                onClick={() => onAsk(`จอง${r.name} วันนี้`)}
                className={`${NOTE_SM} ${PRESS} bg-white self-start px-3 py-1.5 text-[13px] cursor-pointer`}
              >
                จองห้องนี้
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
