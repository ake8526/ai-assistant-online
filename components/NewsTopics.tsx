"use client";

/**
 * เลือกข่าวที่อยากให้ตามให้ — แผ่นในแอป ไม่ใช่หน้าเว็บแยก
 *
 * ของเดิมกดแล้วเด้งออกไป /consents ซึ่งเป็นคนละหน้า พอกดย้อนกลับ แอปโหลดใหม่
 * ทั้งหมดและสิ่งที่ทำค้างไว้ในหน้าตั้งค่าครั้งแรกหายเกลี้ยง หน้านี้เลยอยู่ในแอป
 * เปิดทับข้างบน ปิดแล้วกลับมาที่เดิม ไม่มีอะไรหาย
 *
 * z สูงกว่าหน้าตั้งค่าครั้งแรก (55) เพราะเปิดจากในหน้านั้นได้ — ต่ำกว่านั้น
 * แผ่นนี้จะไปอยู่ใต้หน้าตั้งค่า กดแล้วเหมือนไม่มีอะไรเกิดขึ้น
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { useM365Auth } from "@/components/M365AuthProvider";
import { INK_2, INK_3, N_GREEN, N_PINK, N_YELLOW, NOTE, NOTE_SM, PRESS } from "@/components/noteStyles";

/** เหมือน NEWS_TOPIC_PRESETS ฝั่งเซิร์ฟเวอร์ — เก็บเป็น label ตรง ๆ */
const PRESETS = [
  "น้ำตาล / อ้อย",
  "พลังงาน",
  "เศรษฐกิจ/ธุรกิจ",
  "เทคโนโลยี/IT",
  "AI / นวัตกรรม",
  "เกษตร",
  "ยานยนต์",
  "สุขภาพ",
  "การเมือง",
  "กีฬา",
];

const DAY_LABEL = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
const TIMES = ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00"];

type Prefs = { topics?: string[]; interested?: boolean; count?: number };
type Notify = { news?: { enabled?: boolean; time?: string; days?: number[]; count?: number } };

export function NewsTopicsSheet({ onClose }: { onClose: () => void }) {
  const { getToken } = useM365Auth();
  const [topics, setTopics] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [time, setTime] = useState("07:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [count, setCount] = useState(5);
  const [on, setOn] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const r = await fetch("/api/news/prefs", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { prefs?: Prefs; notify?: Notify };
      setTopics(j.prefs?.topics || []);
      setCount(j.prefs?.count || j.notify?.news?.count || 5);
      setOn(j.notify?.news?.enabled ?? true);
      setTime(j.notify?.news?.time || "07:00");
      setDays(j.notify?.news?.days?.length ? j.notify.news.days : [1, 2, 3, 4, 5]);
      setLoaded(true);
    } catch {
      setErr("โหลดค่าที่ตั้งไว้ไม่สำเร็จ — ตั้งใหม่แล้วบันทึกได้เลยครับ");
      setLoaded(true);
    }
  }, [getToken]);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const toggle = (t: string) =>
    setTopics((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));

  const addCustom = () => {
    const t = custom.trim();
    if (!t) return;
    setTopics((p) => (p.includes(t) ? p : [...p, t]));
    setCustom("");
  };

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const token = await getToken();
      const r = await fetch("/api/news/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          topics,
          interested: topics.length > 0 && on,
          news: { enabled: on && topics.length > 0, time, days, count },
        }),
      });
      if (!r.ok) throw new Error(String(r.status));
      onClose();
    } catch {
      setErr("บันทึกไม่สำเร็จ ลองอีกครั้งครับ");
    }
    setSaving(false);
  };

  const field =
    "font-note text-[12.5px] bg-[var(--nb-board)] text-[var(--nb-ink)] border-2 border-[var(--nb-ink)] rounded-[10px] px-2 py-1";

  return (
    <div className="fixed inset-0 z-[56] flex flex-col bg-[var(--nb-board)]" role="dialog" aria-label="เลือกข่าว">
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b-2 border-[var(--nb-ink)] bg-[var(--nb-surface)]">
        <h2 className="font-marker text-[17px] flex-1">ข่าวที่อยากให้ตามให้</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="ปิด"
          className={`${NOTE_SM} ${PRESS} ${N_PINK} grid place-items-center w-8 h-8 shrink-0 cursor-pointer`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 max-w-md w-full mx-auto">
        {!loaded && <p className={`font-hand text-[16px] ${INK_2} text-center py-6`}>กำลังโหลด…</p>}

        {loaded && (
          <>
            <div className={`${NOTE} bg-[var(--nb-surface)] px-3 py-3`}>
              <h3 className="font-marker text-[14.5px]">เลือกหัวข้อ</h3>
              <p className={`text-[11.5px] ${INK_2} mb-2`}>
                แตะเลือกได้หลายอัน ผู้ช่วยจะไปหาข่าวเรื่องพวกนี้มาสรุปให้
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...PRESETS, ...topics.filter((t) => !PRESETS.includes(t))].map((t) => {
                  const on2 = topics.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggle(t)}
                      aria-pressed={on2}
                      className={`${NOTE_SM} ${PRESS} px-2.5 py-1 text-[12px] cursor-pointer ${
                        on2 ? N_GREEN : "bg-[var(--nb-surface)]"
                      }`}
                    >
                      {on2 && <Check className="w-3 h-3 inline mr-1 -mt-0.5" />}
                      {t}
                    </button>
                  );
                })}
              </div>

              <div className="flex gap-2 mt-3">
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustom();
                    }
                  }}
                  placeholder="เพิ่มเอง เช่น ราคาน้ำตาลตลาดโลก"
                  className={`${NOTE_SM} flex-1 min-w-0 bg-[var(--nb-surface)] px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-[var(--nb-ink-3)]`}
                />
                <button
                  type="button"
                  onClick={addCustom}
                  disabled={!custom.trim()}
                  aria-label="เพิ่มหัวข้อ"
                  className={`${NOTE_SM} ${PRESS} ${N_YELLOW} grid place-items-center w-9 shrink-0 disabled:opacity-40 cursor-pointer`}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              {!topics.length && (
                <p className={`font-hand text-[15px] ${INK_3} mt-2`}>ยังไม่ได้เลือกหัวข้อ — เลือกอย่างน้อย 1 อัน</p>
              )}
            </div>

            <div className={`${NOTE} bg-[var(--nb-surface)] px-3 py-3`}>
              <h3 className="font-marker text-[14.5px]">ส่งให้ตอนไหน</h3>

              <div className="flex items-center gap-2 mt-2">
                <span className="flex-1 text-[12.5px]">เปิดสรุปข่าวรายวัน</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => setOn((p) => !p)}
                  className={`w-10 h-6 shrink-0 border-2 border-[var(--nb-ink)] rounded-full relative cursor-pointer ${
                    on ? N_GREEN : "bg-[var(--nb-board)]"
                  }`}
                >
                  <i
                    className={`absolute top-[2px] w-[15px] h-[15px] rounded-full bg-[var(--nb-ink)] transition-[left] ${
                      on ? "left-[19px]" : "left-[2px]"
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <select className={field} value={time} onChange={(e) => setTime(e.target.value)}>
                  {(TIMES.includes(time) ? TIMES : [...TIMES, time].sort()).map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <span className="text-[12.5px]">น. · วันละ</span>
                <select className={field} value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {[3, 5, 8, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className="text-[12.5px]">ข่าว</span>
              </div>

              <p className={`text-[11.5px] ${INK_2} mt-3`}>ส่งวันไหนบ้าง</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {DAY_LABEL.map((d, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setDays((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort()))}
                    aria-pressed={days.includes(i)}
                    className={`${NOTE_SM} ${PRESS} w-9 py-1 text-[12px] cursor-pointer ${
                      days.includes(i) ? N_GREEN : `bg-[var(--nb-surface)] ${INK_3} shadow-none`
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            {!!err && <p className={`${NOTE_SM} ${N_PINK} px-3 py-2 text-[12px]`}>{err}</p>}
          </>
        )}
      </div>

      <div className="shrink-0 flex gap-2 px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t-2 border-[var(--nb-ink)] bg-[var(--nb-surface)]">
        <button type="button" onClick={onClose} className={`${INK_2} px-3 py-2 text-[13px] cursor-pointer`}>
          ยกเลิก
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !loaded}
          className={`${NOTE} ${PRESS} ${N_YELLOW} flex-1 px-4 py-2.5 text-[14px] font-semibold disabled:opacity-45 cursor-pointer`}
        >
          {saving ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>
    </div>
  );
}
