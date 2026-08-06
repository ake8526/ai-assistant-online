"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useM365Auth } from "@/components/M365AuthProvider";
import { closeWebView, prepareWebViewClose } from "@/lib/closeWebView";
import { CheckCircle2, Clock, LogIn, Newspaper, Sparkles, X } from "lucide-react";

const TOPICS = [
  "เทคโนโลยี/IT",
  "AI / นวัตกรรม",
  "เศรษฐกิจ/ธุรกิจ",
  "พลังงาน",
  "ยานยนต์",
  "สุขภาพ",
  "กีฬา",
  "การเมือง",
  "บันเทิง",
];

const DAY_CHIPS: { label: string; d: number }[] = [
  { label: "จ", d: 1 },
  { label: "อ", d: 2 },
  { label: "พ", d: 3 },
  { label: "พฤ", d: 4 },
  { label: "ศ", d: 5 },
  { label: "ส", d: 6 },
  { label: "อา", d: 0 },
];

type NewsCfg = { enabled: boolean; time: string; days: number[]; count: number };

const selCls =
  "text-sm px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 focus:outline-none focus:border-sky-500";

export default function SetupTestPanel() {
  const { account, login, getToken, ready } = useM365Auth();
  const [topics, setTopics] = useState<string[]>([]);
  const [customTopic, setCustomTopic] = useState("");
  const [news, setNews] = useState<NewsCfg>({
    enabled: true,
    time: "07:00",
    days: [1, 2, 3, 4, 5],
    count: 3,
  });
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");

  const [hh, mm] = (news.time || "07:00").split(":");

  const exit = useCallback(async () => {
    await closeWebView();
  }, []);

  const save = async () => {
    setBusy(true);
    setHint("");
    try {
      if (topics.length > 0) {
        const token = await getToken();
        if (token) {
          const res = await fetch("/api/news/prefs", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ topics, interested: true, complete: false, news }),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
        }
      }
    } catch (e) {
      setHint(String((e as Error).message));
      setBusy(false);
      return;
    }
    setBusy(false);
    await exit();
  };

  useEffect(() => {
    prepareWebViewClose();
  }, []);

  useEffect(() => {
    if (!ready || !account) return;
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const res = await fetch("/api/news/prefs", {
          cache: "no-store",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.prefs?.topics?.length) setTopics(data.prefs.topics);
        if (data.notify?.news) {
          setNews((c) => ({
            ...c,
            enabled: data.notify.news.enabled ?? c.enabled,
            time: data.notify.news.time || c.time,
            days: data.notify.news.days?.length ? data.notify.news.days : c.days,
            count: data.notify.news.count ?? c.count,
          }));
        }
      } catch {
        /* preview only */
      }
    })();
  }, [ready, account, getToken]);

  const selectedLabel =
    topics.length === 0
      ? "ยังไม่ได้เลือกหัวข้อ"
      : `เลือกแล้ว ${topics.length} หัวข้อ: ${topics.join(", ")}`;

  const countLabel =
    news.count === 0 ? "ทั้งหมดที่อัปเดตวันนี้" : `${news.count} ข่าว/วัน`;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col">
      <header className="p-5 border-b border-slate-800 bg-slate-900/90">
        <div className="inline-flex items-center gap-2 text-amber-400 text-[11px] font-semibold mb-1">
          <Sparkles className="w-3.5 h-3.5" /> หน้าทดสอบ — ตั้งค่าบนเว็บ
        </div>
        <h1 className="text-lg font-bold">ตั้งค่าข่าว & เวลาแจ้ง</h1>
        <p className="text-xs text-slate-400 mt-1">เลือกหัวข้อ · จำนวนข่าว · เวลาส่ง — จบในหน้าเดียว</p>
        {!account ? (
          <button
            type="button"
            onClick={login}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white"
          >
            <LogIn className="w-3.5 h-3.5" /> เข้าสู่ระบบ M365 (ถ้าต้องการบันทึกจริง)
          </button>
        ) : (
          <p className="text-[11px] text-emerald-400/80 mt-2">{account.username}</p>
        )}
      </header>

      <main className="flex-1 p-4 pb-28 space-y-4 overflow-y-auto">
        <section className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
          <p className="text-xs font-semibold text-slate-300 mb-3">① หัวข้อแนะนำ</p>
          <div className="flex flex-wrap gap-2">
            {TOPICS.map((t) => {
              const on = topics.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    setTopics((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
                  }
                  className={`px-3 py-2.5 rounded-full text-xs font-semibold border transition active:scale-[0.98] ${
                    on
                      ? "bg-sky-500 text-slate-950 border-sky-400 shadow shadow-sky-500/20"
                      : "bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-500"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {t}
                </button>
              );
            })}
          </div>
        </section>

        <section className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2">
          <p className="text-xs font-semibold text-slate-300">หัวข้ออื่น</p>
          <div className="flex gap-2">
            <input
              value={customTopic}
              onChange={(e) => setCustomTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const t = customTopic.trim().slice(0, 60);
                  if (t && !topics.includes(t)) setTopics((cur) => [...cur, t]);
                  setCustomTopic("");
                }
              }}
              placeholder="เช่น เซมิคอนดักเตอร์"
              className="flex-1 text-sm px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 focus:border-sky-500 outline-none"
            />
            <button
              type="button"
              onClick={() => {
                const t = customTopic.trim().slice(0, 60);
                if (!t || topics.includes(t)) return;
                setTopics((cur) => [...cur, t]);
                setCustomTopic("");
              }}
              className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-800 border border-slate-700"
            >
              เพิ่ม
            </button>
          </div>
          <p className="text-[11px] text-slate-500">{selectedLabel}</p>
        </section>

        <section className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Newspaper className="w-4 h-4 text-sky-400" />
              <p className="text-xs font-semibold text-slate-300">② สรุปข่าวเข้า LINE</p>
            </div>
            <button
              type="button"
              onClick={() => setNews((c) => ({ ...c, enabled: !c.enabled }))}
              role="switch"
              aria-checked={news.enabled}
              className={`relative w-10 h-5 shrink-0 rounded-full transition ${news.enabled ? "bg-emerald-500" : "bg-slate-600"}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition ${news.enabled ? "translate-x-5" : ""}`}
              />
            </button>
          </div>

          <div className={`space-y-3 ${news.enabled ? "" : "opacity-50 pointer-events-none"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400" />
              <span className="text-xs text-slate-300">เวลาส่ง</span>
              <select
                value={hh}
                onChange={(e) =>
                  setNews((c) => ({
                    ...c,
                    time: `${e.target.value.padStart(2, "0")}:${mm.padStart(2, "0")}`,
                  }))
                }
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
                onChange={(e) =>
                  setNews((c) => ({
                    ...c,
                    time: `${hh.padStart(2, "0")}:${e.target.value.padStart(2, "0")}`,
                  }))
                }
                className={selCls}
              >
                {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-slate-500">น.</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Newspaper className="w-4 h-4 text-slate-400" />
              <span className="text-xs text-slate-300">จำนวนข่าว/วัน</span>
              <select
                value={String(news.count)}
                onChange={(e) => setNews((c) => ({ ...c, count: Number(e.target.value) }))}
                className={selCls}
              >
                <option value={0}>ทั้งหมดที่อัปเดตวันนี้</option>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} ข่าว
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-2">วันที่ส่ง</p>
              <div className="flex flex-wrap gap-1.5">
                {DAY_CHIPS.map(({ label, d }) => {
                  const on = news.days.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() =>
                        setNews((c) => ({
                          ...c,
                          days: c.days.includes(d) ? c.days.filter((x) => x !== d) : [...c.days, d],
                        }))
                      }
                      className={`w-9 h-9 rounded-lg text-xs font-semibold border transition ${
                        on ? "bg-sky-500 text-slate-950 border-sky-400" : "bg-slate-950/40 text-slate-400 border-slate-700"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              {news.enabled
                ? `ส่ง ${countLabel} เวลา ${news.time} น. (${news.days.length} วัน/สัปดาห์)`
                : "ปิดการส่งสรุปข่าวอัตโนมัติ"}
            </p>
          </div>
        </section>

        {hint && <p className="text-xs text-amber-400 px-1">{hint}</p>}
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
            className="flex-1 py-3.5 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <CheckCircle2 className="w-4 h-4" />
            {busy ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </div>
      </footer>
    </div>
  );
}
