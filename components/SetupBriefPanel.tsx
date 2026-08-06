"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useM365Auth } from "@/components/M365AuthProvider";
import { closeWebView, prepareWebViewClose, showManualCloseHint } from "@/lib/closeWebView";
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

type NotifyKindCfg = { enabled: boolean; time: string; days: number[] };

function ScheduleBlock({
  title,
  hint,
  icon,
  cfg,
  onChange,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  cfg: NotifyKindCfg;
  onChange: (patch: Partial<NotifyKindCfg>) => void;
}) {
  const [hh, mm] = (cfg.time || "07:00").split(":");
  const setPart = (h: string, m: string) => onChange({ time: `${h.padStart(2, "0")}:${m.padStart(2, "0")}` });
  const selCls =
    "text-sm px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 focus:outline-none focus:border-sky-500";

  return (
    <div
      className={`p-4 rounded-xl bg-slate-800/60 border border-slate-700 space-y-3 ${cfg.enabled ? "" : "opacity-70"}`}
    >
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
          className={`relative w-11 h-6 shrink-0 rounded-full transition ${
            cfg.enabled ? "bg-emerald-500" : "bg-slate-600"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition ${
              cfg.enabled ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Clock className="w-4 h-4 text-slate-400" />
        <span className="text-xs text-slate-300">เวลาส่ง</span>
        <select
          value={hh}
          disabled={!cfg.enabled}
          onChange={(e) => setPart(e.target.value, mm)}
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
          disabled={!cfg.enabled}
          onChange={(e) => setPart(hh, e.target.value)}
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

export default function SetupBriefPanel() {
  const { account, login, getToken, reauth, ready } = useM365Auth();
  const [brief, setBrief] = useState<NotifyKindCfg>({ enabled: true, time: "07:00", days: [1, 2, 3, 4, 5] });
  const [calLinked, setCalLinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [msgOk, setMsgOk] = useState(false);
  const [needReauth, setNeedReauth] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    prepareWebViewClose();
  }, []);

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

      if (data.notify?.brief) {
        setBrief({
          enabled: data.notify.brief.enabled ?? true,
          time: data.notify.brief.time || "07:00",
          days: data.notify.brief.days?.length ? data.notify.brief.days : [1, 2, 3, 4, 5],
        });
      }
      setCalLinked(!!data.calLinked);
      setDone(!!data.prefs?.onboardingDone);
    } catch (e) {
      setMsg(String((e as Error).message));
      setMsgOk(false);
    }
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
      const params = new URLSearchParams(window.location.search);
      params.delete("ms");
      const qs = params.toString();
      const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }
  }, []);

  const exit = useCallback(async () => {
    const closed = await closeWebView();
    if (!closed) showManualCloseHint();
  }, []);

  const save = useCallback(
    async (complete: boolean) => {
      setBusy(true);
      setMsg("");
      setMsgOk(false);
      try {
        const token = await getToken();
        if (!account) {
          login();
          return;
        }
        if (!token) {
          setNeedReauth(true);
          throw new Error("กรุณาเข้าสู่ระบบก่อน");
        }

        if (complete && brief.enabled && (!brief.days || brief.days.length === 0)) {
          throw new Error("เลือกอย่างน้อย 1 วันก่อนครับ");
        }

        const res = await fetch("/api/news/prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            brief,
            complete,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        setCalLinked(!!data.calLinked);
        setDone(!!data.prefs?.onboardingDone);

        const closed = await closeWebView();
        if (!closed) showManualCloseHint();
      } catch (e) {
        setMsg(String((e as Error).message));
        setMsgOk(false);
      } finally {
        setBusy(false);
      }
    },
    [account, brief, getToken, login]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col">
      <header className="p-5 border-b border-slate-800 bg-slate-900/90">
        <div className="inline-flex items-center gap-2 text-amber-400 text-[11px] font-semibold mb-1">
          <Sparkles className="w-3.5 h-3.5" /> ตั้งค่าเริ่มต้น — Morning Brief
        </div>
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Sun className="w-5 h-5 text-amber-400" /> สรุปตารางเช้า
        </h1>
        <p className="text-xs text-slate-400 mt-1">สรุปนัดประชุมวันนี้เข้า LINE ตอนเช้า — ต้องอนุญาตปฏิทินก่อน</p>
        {msg && <p className={`text-xs mt-2 ${msgOk ? "text-emerald-400" : "text-rose-400"}`}>{msg}</p>}
        {needReauth && (
          <button
            type="button"
            onClick={() => reauth()}
            className="mt-3 w-full inline-flex items-center justify-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white"
          >
            ยืนยันตัวตนอีกครั้ง
          </button>
        )}
      </header>

      <main className="flex-1 p-4 pb-28 space-y-4 overflow-y-auto">
        <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
          <ScheduleBlock
            title="Morning Brief"
            hint="สรุปนัดประชุมวันนี้ — ต้องอนุญาตปฏิทินก่อน"
            icon={<Calendar className="w-5 h-5" />}
            cfg={brief}
            onChange={(patch) => setBrief((c) => ({ ...c, ...patch }))}
          />
        </section>

        <section className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2">
          <p className="text-xs font-semibold text-slate-300">ปฏิทิน M365 (จำเป็น)</p>
          <Link
            href="/account?return=/setup"
            className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/60 border border-slate-700 hover:border-amber-500/40 transition"
          >
            <Calendar className="w-5 h-5 text-emerald-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">อนุญาตปฏิทิน</div>
              <div className="text-[11px] text-slate-400">{calLinked ? "✅ อนุญาตแล้ว" : "ยังไม่ได้อนุญาต — กดเพื่อเปิด"}</div>
            </div>
          </Link>
        </section>

        <p className="text-[10px] text-amber-400/80 px-1">กดบันทึก/ยกเลิก → ปิดกลับแชท (LIFF)</p>
      </main>

      <footer className="fixed bottom-0 inset-x-0 p-4 bg-slate-950/95 border-t border-slate-800 backdrop-blur">
        <div className="max-w-lg mx-auto flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={exit}
            className="sm:flex-1 py-3 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-600 hover:bg-slate-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <X className="w-4 h-4" /> ยกเลิก
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => save(false)}
            className="sm:flex-1 py-3 rounded-xl text-sm font-semibold bg-slate-800 border border-slate-700 hover:bg-slate-700 disabled:opacity-50"
          >
            บันทึกชั่วคราว
          </button>
          <button
            type="button"
            disabled={busy || done}
            onClick={() => save(true)}
            className="sm:flex-1 py-3 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <CheckCircle2 className="w-4 h-4" />
            {done ? "ตั้งค่าเสร็จแล้ว" : "เสร็จสิ้น — ส่งสรุปไป LINE"}
          </button>
        </div>
      </footer>
    </div>
  );
}

