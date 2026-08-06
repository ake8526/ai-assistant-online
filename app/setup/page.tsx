"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  LogIn,
  Newspaper,
  Rss,
  Sparkles,
  Youtube,
} from "lucide-react";

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

type NotifyKindCfg = { enabled: boolean; time: string; days: number[]; count?: number };

function ScheduleBlock({
  title,
  hint,
  icon,
  cfg,
  showCount,
  onChange,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  cfg: NotifyKindCfg;
  showCount?: boolean;
  onChange: (patch: Partial<NotifyKindCfg>) => void;
}) {
  const [hh, mm] = (cfg.time || "07:00").split(":");
  const setPart = (h: string, m: string) =>
    onChange({ time: `${h.padStart(2, "0")}:${m.padStart(2, "0")}` });
  const selCls =
    "text-sm px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 focus:outline-none focus:border-sky-500";

  return (
    <div className={`p-4 rounded-xl bg-slate-800/60 border border-slate-700 space-y-3 ${cfg.enabled ? "" : "opacity-70"}`}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center bg-sky-500/20 text-sky-300">
          {icon}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          <div className="text-[11px] text-slate-400">{hint}</div>
        </div>
        <button
          type="button"
          onClick={() => onChange({ enabled: !cfg.enabled })}
          role="switch"
          aria-checked={cfg.enabled}
          className={`relative w-11 h-6 shrink-0 rounded-full transition ${cfg.enabled ? "bg-emerald-500" : "bg-slate-600"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition ${cfg.enabled ? "translate-x-5" : ""}`}
          />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Clock className="w-4 h-4 text-slate-400" />
        <span className="text-xs text-slate-300">เวลาส่ง</span>
        <select value={hh} disabled={!cfg.enabled} onChange={(e) => setPart(e.target.value, mm)} className={selCls}>
          {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <span className="text-slate-400">:</span>
        <select value={mm} disabled={!cfg.enabled} onChange={(e) => setPart(hh, e.target.value)} className={selCls}>
          {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-slate-500">น.</span>
      </div>

      {showCount && (
        <div className="flex flex-wrap items-center gap-2">
          <Newspaper className="w-4 h-4 text-slate-400" />
          <span className="text-xs text-slate-300">จำนวนข่าว/วัน</span>
          <select
            value={String(cfg.count ?? 3)}
            disabled={!cfg.enabled}
            onChange={(e) => onChange({ count: Number(e.target.value) })}
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
      )}

      <div className="flex flex-wrap gap-1.5">
        {DAY_CHIPS.map(({ label, d }) => {
          const on = cfg.days.includes(d);
          return (
            <button
              key={d}
              type="button"
              disabled={!cfg.enabled}
              onClick={() =>
                onChange({ days: on ? cfg.days.filter((x) => x !== d) : [...cfg.days, d] })
              }
              className={`w-9 h-9 rounded-lg text-xs font-semibold border transition disabled:opacity-50 ${
                on ? "bg-sky-500 text-slate-950 border-sky-400" : "bg-slate-950/40 text-slate-400 border-slate-700"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SetupContent() {
  const { account, login, getToken, reauth, ready } = useM365Auth();
  const [topics, setTopics] = useState<string[]>([]);
  const [customTopic, setCustomTopic] = useState("");
  const [news, setNews] = useState<NotifyKindCfg>({
    enabled: true,
    time: "07:00",
    days: [1, 2, 3, 4, 5],
    count: 3,
  });
  const [brief, setBrief] = useState<NotifyKindCfg>({
    enabled: true,
    time: "07:00",
    days: [1, 2, 3, 4, 5],
  });
  const [calLinked, setCalLinked] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgOk, setMsgOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needReauth, setNeedReauth] = useState(false);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    const token = await getToken();
    if (!token) {
      setNeedReauth(true);
      return;
    }
    setNeedReauth(false);
    try {
      const res = await fetch("/api/news/prefs", {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTopics(data.prefs?.topics || []);
      setCalLinked(!!data.calLinked);
      if (data.notify?.news) setNews({ ...news, ...data.notify.news });
      if (data.notify?.brief) setBrief({ ...brief, ...data.notify.brief });
      setDone(!!data.prefs?.onboardingDone);
    } catch (e) {
      setMsg(String((e as Error).message));
      setMsgOk(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, getToken]);

  useEffect(() => {
    if (!ready) return;
    load();
  }, [ready, load]);

  useEffect(() => {
    const ms = new URLSearchParams(window.location.search).get("ms");
    if (ms === "connected") {
      setMsg("✅ อนุญาตปฏิทินเรียบร้อยแล้ว");
      setMsgOk(true);
      setCalLinked(true);
      window.history.replaceState({}, "", "/setup");
    }
  }, []);

  const toggleTopic = (t: string) => {
    setTopics((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  };

  const addCustom = () => {
    const t = customTopic.trim().slice(0, 60);
    if (!t || topics.includes(t)) return;
    setTopics((cur) => [...cur, t]);
    setCustomTopic("");
  };

  const save = async (complete: boolean) => {
    if (complete && topics.length === 0) {
      setMsg("เลือกหัวข้อข่าวอย่างน้อย 1 หัวข้อก่อนครับ");
      setMsgOk(false);
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const token = await getToken();
      if (!token) {
        setNeedReauth(true);
        throw new Error("กรุณาเข้าสู่ระบบก่อน");
      }
      const res = await fetch("/api/news/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          topics,
          interested: true,
          news,
          brief,
          complete,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCalLinked(!!data.calLinked);
      if (complete) {
        setDone(true);
        setMsg("✅ บันทึกเรียบร้อย — สรุปการตั้งค่าถูกส่งไปที่ LINE แล้วครับ");
        setMsgOk(true);
      } else {
        setMsg("บันทึกชั่วคราวแล้ว — กด “เสร็จสิ้น” เมื่อพร้อม");
        setMsgOk(true);
      }
    } catch (e) {
      setMsg(String((e as Error).message));
      setMsgOk(false);
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-2xl mx-auto space-y-5">
        <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
          <ArrowLeft className="w-4 h-4" /> ตั้งค่า
        </Link>

        <header className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 text-center">
          <div className="inline-flex items-center gap-2 text-sky-400 text-xs font-semibold mb-2">
            <Sparkles className="w-4 h-4" /> ตั้งค่าเริ่มต้น
          </div>
          <h1 className="text-xl font-bold">ตั้งค่าผู้ช่วยบนเว็บ</h1>
          <p className="text-xs text-slate-400 mt-1">
            เลือกหัวข้อข่าว · เวลาแจ้ง · ผูก YouTube/RSS · อนุญาตปฏิทิน — ทำครั้งเดียวจบ
          </p>
          {!account ? (
            <button
              onClick={login}
              className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white"
            >
              <LogIn className="w-4 h-4" /> เข้าสู่ระบบ Microsoft 365
            </button>
          ) : (
            <p className="text-[11px] text-emerald-400/80 mt-2">{account.username}</p>
          )}
          {msg && <p className={`text-xs mt-2 ${msgOk ? "text-emerald-400" : "text-rose-400"}`}>{msg}</p>}
          {needReauth && (
            <button
              onClick={() => reauth()}
              className="mt-3 w-full inline-flex items-center justify-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white"
            >
              <LogIn className="w-4 h-4" /> ยืนยันตัวตนอีกครั้ง
            </button>
          )}
        </header>

        {account && (
          <>
            <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
              <h2 className="text-sm font-bold text-slate-200">① หัวข้อข่าวที่สนใจ</h2>
              <p className="text-xs text-slate-400">กดเลือกได้หลายหัวข้อ · หรือพิมพ์เองด้านล่าง</p>
              <div className="flex flex-wrap gap-2">
                {TOPICS.map((t) => {
                  const on = topics.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTopic(t)}
                      className={`px-3 py-2 rounded-full text-xs font-semibold border transition ${
                        on
                          ? "bg-sky-500 text-slate-950 border-sky-400"
                          : "bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-500"
                      }`}
                    >
                      {on ? "✓ " : ""}
                      {t}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <input
                  value={customTopic}
                  onChange={(e) => setCustomTopic(e.target.value)}
                  placeholder="หัวข้ออื่น เช่น เซมิคอนดักเตอร์"
                  className="flex-1 text-sm px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 focus:border-sky-500 outline-none"
                />
                <button
                  type="button"
                  onClick={addCustom}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 border border-slate-700 hover:bg-slate-700"
                >
                  เพิ่ม
                </button>
              </div>
            </section>

            <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
              <h2 className="text-sm font-bold text-slate-200">② สรุปข่าวเข้า LINE</h2>
              <ScheduleBlock
                title="สรุปข่าวรายวัน"
                hint="ดึงจากหัวข้อ + YouTube/RSS ที่ผูกไว้"
                icon={<Newspaper className="w-5 h-5" />}
                cfg={news}
                showCount
                onChange={(patch) => setNews((c) => ({ ...c, ...patch }))}
              />
            </section>

            <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
              <h2 className="text-sm font-bold text-slate-200">③ ผูกแหล่งข่าว & ปฏิทิน</h2>
              <p className="text-xs text-slate-400">เปิดหน้าย่อยแล้วกลับมากด “เสร็จสิ้น” ด้านล่าง</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Link
                  href="/consents"
                  className="flex items-center gap-3 p-4 rounded-xl bg-slate-800/60 border border-slate-700 hover:border-sky-500/50 transition"
                >
                  <Youtube className="w-5 h-5 text-red-400" />
                  <div>
                    <div className="text-sm font-semibold">YouTube / RSS</div>
                    <div className="text-[11px] text-slate-400">ผูกช่องและฟีดข่าว</div>
                  </div>
                  <Rss className="w-4 h-4 text-slate-500 ml-auto" />
                </Link>
                <Link
                  href="/account"
                  className="flex items-center gap-3 p-4 rounded-xl bg-slate-800/60 border border-slate-700 hover:border-sky-500/50 transition"
                >
                  <Calendar className="w-5 h-5 text-emerald-400" />
                  <div>
                    <div className="text-sm font-semibold">ปฏิทิน M365</div>
                    <div className="text-[11px] text-slate-400">
                      {calLinked ? "✅ อนุญาตแล้ว" : "ยังไม่ได้อนุญาต — กดเพื่อเปิด"}
                    </div>
                  </div>
                </Link>
              </div>
            </section>

            <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
              <h2 className="text-sm font-bold text-slate-200">④ สรุปตารางเช้า (Morning Brief)</h2>
              <ScheduleBlock
                title="Morning Brief"
                hint="สรุปนัดประชุมวันนี้ — ต้องอนุญาตปฏิทินก่อน"
                icon={<Calendar className="w-5 h-5" />}
                cfg={brief}
                onChange={(patch) => setBrief((c) => ({ ...c, ...patch }))}
              />
            </section>

            <div className="flex flex-col sm:flex-row gap-2 pb-8">
              <button
                type="button"
                disabled={busy}
                onClick={() => save(false)}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-700 hover:bg-slate-700 disabled:opacity-50"
              >
                บันทึกชั่วคราว
              </button>
              <button
                type="button"
                disabled={busy || done}
                onClick={() => save(true)}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4" />
                {done ? "ตั้งค่าเสร็จแล้ว" : "เสร็จสิ้น — ส่งสรุปไป LINE"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function SetupPage() {
  return (
    <M365AuthProvider>
      <SetupContent />
    </M365AuthProvider>
  );
}
