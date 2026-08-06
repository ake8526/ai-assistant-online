"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { closeWebView, prepareWebViewClose } from "@/lib/closeWebView";
import { Calendar, CheckCircle2, Clock, Sparkles, Sun, X } from "lucide-react";

const DAY_CHIPS: { label: string; d: number }[] = [
  { label: "จ", d: 1 },
  { label: "อ", d: 2 },
  { label: "พ", d: 3 },
  { label: "พฤ", d: 4 },
  { label: "ศ", d: 5 },
  { label: "ส", d: 6 },
  { label: "อา", d: 0 },
];

const selCls =
  "text-sm px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 focus:outline-none focus:border-amber-500";

/** Morning Brief preview — UI mock only until wired to API. */
export default function SetupBriefPreviewPanel() {
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState("07:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [calLinked, setCalLinked] = useState(false);
  const [busy, setBusy] = useState(false);

  const [hh, mm] = time.split(":");

  useEffect(() => {
    prepareWebViewClose();
  }, []);

  const toggleDay = (d: number) => {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  };

  const exit = useCallback(async () => {
    await closeWebView();
  }, []);

  const save = async () => {
    setBusy(true);
    await new Promise((r) => setTimeout(r, 400));
    setBusy(false);
    await exit();
  };

  const dayLabel = days.length ? `${days.length} วัน/สัปดาห์` : "ยังไม่เลือกวัน";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col">
      <header className="p-5 border-b border-slate-800 bg-slate-900/90">
        <div className="inline-flex items-center gap-2 text-amber-400 text-[11px] font-semibold mb-1">
          <Sparkles className="w-3.5 h-3.5" /> ตัวอย่าง — Morning Brief
        </div>
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Sun className="w-5 h-5 text-amber-400" /> สรุปตารางเช้า
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          ส่งสรุปนัดประชุมวันนี้เข้า LINE ตอนเช้า — ต้องอนุญาตปฏิทินก่อน
        </p>
      </header>

      <main className="flex-1 p-4 pb-28 space-y-4 overflow-y-auto">
        <section className="p-4 rounded-2xl bg-slate-900/80 border border-amber-500/20 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-slate-200">Morning Brief</p>
              <p className="text-[11px] text-slate-400 mt-0.5">สรุปนัดวันนี้ + เวลาว่างโดยประมาณ</p>
            </div>
            <button
              type="button"
              onClick={() => setEnabled((v) => !v)}
              role="switch"
              aria-checked={enabled}
              className={`relative w-11 h-6 shrink-0 rounded-full transition ${enabled ? "bg-amber-500" : "bg-slate-600"}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition ${enabled ? "translate-x-5" : ""}`}
              />
            </button>
          </div>

          <div className={`space-y-3 ${enabled ? "" : "opacity-50 pointer-events-none"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400" />
              <span className="text-xs text-slate-300">เวลาส่ง</span>
              <select
                value={hh}
                onChange={(e) => setTime(`${e.target.value.padStart(2, "0")}:${mm}`)}
                className={selCls}
              >
                {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <span className="text-slate-400">:</span>
              <select
                value={mm}
                onChange={(e) => setTime(`${hh}:${e.target.value.padStart(2, "0")}`)}
                className={selCls}
              >
                {["00", "15", "30", "45"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-slate-500">น.</span>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-2">วันที่ส่ง</p>
              <div className="flex flex-wrap gap-1.5">
                {DAY_CHIPS.map(({ label, d }) => {
                  const on = days.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleDay(d)}
                      className={`w-9 h-9 rounded-lg text-xs font-semibold border transition ${
                        on
                          ? "bg-amber-500 text-slate-950 border-amber-400"
                          : "bg-slate-950/40 text-slate-400 border-slate-700"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              {enabled ? `ส่งทุก ${dayLabel} เวลา ${time} น.` : "ปิด Morning Brief แล้ว"}
            </p>
          </div>
        </section>

        <section className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2">
          <p className="text-xs font-semibold text-slate-300">ปฏิทิน M365 (จำเป็น)</p>
          <Link
            href="/account?ms=connected"
            className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/60 border border-slate-700 hover:border-amber-500/40 transition"
          >
            <Calendar className="w-5 h-5 text-emerald-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">อนุญาตปฏิทิน</div>
              <div className="text-[11px] text-slate-400">
                {calLinked ? "✅ อนุญาตแล้ว" : "กดเพื่อเปิดหน้าอนุญาต — แล้วกลับมากดบันทึก"}
              </div>
            </div>
          </Link>
          <button
            type="button"
            onClick={() => setCalLinked((v) => !v)}
            className="text-[10px] text-slate-500 underline"
          >
            (ตัวอย่าง) สลับสถานะปฏิทิน
          </button>
        </section>

        <section className="p-4 rounded-2xl bg-slate-900/50 border border-dashed border-slate-700">
          <p className="text-[11px] font-semibold text-slate-400 mb-2">ตัวอย่างข้อความใน LINE</p>
          <pre className="text-[11px] text-slate-300 whitespace-pre-wrap leading-relaxed font-sans">
{`☀️ Morning Brief — วันนี้ 6 ส.ค.
📅 3 นัด · ว่างช่วงบ่าย

09:00  Sync ทีม
11:00  1:1 กับเบส
14:00  Review Q3

💡 ช่วงว่าง: 15:30–17:00`}
          </pre>
        </section>

        <p className="text-[10px] text-amber-400/80 px-1">
          🧪 หน้านี้เป็นตัวอย่าง UI — ยังไม่บันทึกจริง รอสั่งทำต่อ
        </p>
      </main>

      <footer className="fixed bottom-0 inset-x-0 p-4 bg-slate-950/95 border-t border-slate-800 backdrop-blur">
        <div className="max-w-lg mx-auto flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => exit()}
            className="flex-1 py-3.5 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-600 hover:bg-slate-700 inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <X className="w-4 h-4" /> ยกเลิก
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => save()}
            className="flex-1 py-3.5 rounded-xl text-sm font-semibold bg-amber-600 hover:bg-amber-500 text-slate-950 inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            {busy ? "กำลังบันทึก…" : "บันทึก (ตัวอย่าง)"}
          </button>
        </div>
        <p className="text-[10px] text-center text-slate-500 mt-2">กดบันทึกหรือยกเลิก → ปิดกลับแชท (LIFF)</p>
      </footer>
    </div>
  );
}
