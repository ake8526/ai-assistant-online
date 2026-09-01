"use client";

import React, { useMemo, useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { useM365Auth } from "@/components/M365AuthProvider";
import {
  BlankNote,
  FOLD,
  INK_2,
  INK_3,
  N_GREEN,
  N_PINK,
  N_YELLOW,
  NOTE,
  NOTE_SM,
  PRESS,
} from "@/components/noteStyles";

export type Task = {
  id: number;
  title: string;
  detail?: string;
  responsible?: string;
  due?: string | null;
  status: string;
  source?: string;
};

/** วันครบกำหนดเทียบกับวันนี้ — เอาไปเลือกสีโน้ตและป้าย */
function dueInfo(due?: string | null): { tint: string; tag: string; text: string } {
  if (!due) return { tint: "", tag: "ไม่มีกำหนด", text: "ยังไม่กำหนดวันส่ง" };
  const d = new Date(due);
  if (isNaN(d.getTime())) return { tint: "", tag: "ไม่มีกำหนด", text: "ยังไม่กำหนดวันส่ง" };

  const now = new Date();
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(now)) / 86_400_000);
  const when = d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  if (days < 0) return { tint: N_PINK, tag: `เกิน ${-days} วัน`, text: `ครบกำหนด ${when}` };
  if (days === 0) return { tint: N_YELLOW, tag: "วันนี้", text: `ครบกำหนดวันนี้ ${when.split(" ").pop()}` };
  if (days === 1) return { tint: "", tag: "พรุ่งนี้", text: `ครบกำหนด ${when}` };
  return { tint: "", tag: `อีก ${days} วัน`, text: `ครบกำหนด ${when}` };
}

/**
 * งานที่ต้องติดตาม
 *
 * รายการมาจากเปลือกแอปซึ่งดึงไว้ตอนฉากโหลดและตามเก็บเงียบ ๆ ทุกนาที เปิดแท็บนี้
 * จึงเห็นของเดิมทันทีทุกครั้ง ไม่มีรอบโหลดใหม่ให้รอ และงานที่เพิ่งเข้ามาจะโผล่
 * ขึ้นเองโดยไม่มีตัวหมุนหรือหน้าจอกระพริบ
 *
 * การปิดงานต้องกดยืนยันอีกครั้งเสมอ ปุ่มที่ยืนยันเขียนว่า "ยืนยันปิดงาน" ตรง ๆ
 * ไม่ใช่ "ยืนยัน" ลอย ๆ ตามกฎของโปรเจ็กต์ เพราะคำยืนยันลอย ๆ เคยไปตกกับคำสั่ง
 * อื่นที่มีผลออกนอกระบบ
 */
export default function TasksTab({
  tasks,
  err,
  syncing,
  onChange,
  onReload,
}: {
  tasks: Task[] | null;
  err: string;
  syncing: boolean;
  onChange: (next: Task[]) => void;
  onReload: () => void;
}) {
  const { getToken } = useM365Auth();
  const [confirming, setConfirming] = useState<number | null>(null);
  const [closing, setClosing] = useState<number | null>(null);
  const [closeErr, setCloseErr] = useState("");

  // อ้างอิงคงที่เมื่อ tasks ไม่เปลี่ยน ไม่ให้ useMemo ข้างล่างคิดใหม่ทุกรอบวาด
  const list = useMemo(() => tasks || [], [tasks]);
  const firstLoad = tasks === null && !err;

  const closeTask = async (id: number) => {
    setClosing(id);
    try {
      const token = await getToken();
      const r = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: "done" }),
      });
      if (!r.ok) throw new Error(String(r.status));
      onChange(list.filter((t) => t.id !== id));
      setCloseErr("");
    } catch {
      setCloseErr("ปิดงานไม่สำเร็จ ลองอีกครั้งครับ");
    }
    setClosing(null);
    setConfirming(null);
  };

  const counts = useMemo(() => {
    let over = 0,
      today = 0,
      later = 0;
    for (const t of list) {
      const info = dueInfo(t.due);
      if (info.tag.startsWith("เกิน")) over++;
      else if (info.tag === "วันนี้") today++;
      else later++;
    }
    return { over, today, later };
  }, [list]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-marker text-[19px]">งานที่ต้องติดตาม</h2>
        <button
          onClick={onReload}
          disabled={syncing}
          className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] px-2.5 py-1 font-hand text-[15px] font-bold disabled:opacity-50 cursor-pointer`}
        >
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "โหลดใหม่"}
        </button>
      </div>

      {!!list.length && (
        <div data-tour="task-list" className={`${NOTE_SM} ${counts.over ? N_PINK : N_GREEN} px-3.5 py-2.5 -rotate-[0.4deg]`}>
          <p className="font-hand text-[16px]">
            เกินกำหนด {counts.over} · วันนี้ {counts.today} · หลังจากนี้ {counts.later}
          </p>
          <p className={`text-[11.5px] ${INK_2}`}>งานใหม่ขึ้นเองทุกนาที ไม่ต้องกดโหลด</p>
        </div>
      )}

      {(err || closeErr) && (
        <BlankNote tint={N_PINK}>
          {closeErr || err}
          <button
            onClick={() => {
              setCloseErr("");
              onReload();
            }}
            className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] mt-3 inline-flex items-center gap-1.5 px-3 py-1 text-[13px] font-note cursor-pointer`}
          >
            <RefreshCw className="w-3.5 h-3.5" /> ลองอีกครั้ง
          </button>
        </BlankNote>
      )}

      {firstLoad && <BlankNote>กำลังโหลดงาน…</BlankNote>}
      {!err && tasks !== null && !list.length && (
        <BlankNote tint={N_GREEN}>ไม่มีงานค้างครับ เคลียร์หมดแล้ว</BlankNote>
      )}

      <div className="flex flex-col gap-3">
        {list.map((t, i) => {
          const info = dueInfo(t.due);
          const asking = confirming === t.id;
          return (
            <div
              key={t.id}
              className={`${NOTE} ${FOLD} ${info.tint || "bg-[var(--nb-surface)]"} p-3.5 flex flex-col gap-2.5 ${
                i % 2 ? "rotate-[0.4deg]" : "-rotate-[0.4deg]"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[14.5px] leading-snug">{t.title}</div>
                  <div className={`text-[11.5px] ${INK_2}`}>
                    {info.text}
                    {t.responsible ? ` · ${t.responsible}` : ""}
                  </div>
                </div>
                <span
                  className={`${NOTE_SM} bg-[var(--nb-surface)] px-2 py-0.5 font-hand text-[14.5px] font-bold shrink-0`}
                >
                  {info.tag}
                </span>
              </div>

              {asking ? (
                <div className="flex items-center gap-2.5">
                  <button
                    onClick={() => void closeTask(t.id)}
                    disabled={closing === t.id}
                    className={`${NOTE_SM} ${PRESS} ${N_GREEN} px-3 py-1.5 text-[13px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer`}
                  >
                    {closing === t.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    ยืนยันปิดงาน
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className={`font-hand text-[15px] ${INK_3} underline decoration-wavy underline-offset-4 cursor-pointer`}
                  >
                    ยังไม่ปิด
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirming(t.id)}
                  className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] self-start px-3 py-1.5 text-[13px] cursor-pointer`}
                >
                  ปิดงานนี้
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
