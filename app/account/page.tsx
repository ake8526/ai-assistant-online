"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import {
  ArrowLeft, CheckCircle2, XCircle, LogIn, LogOut, Unlink, AlertTriangle,
  Mail, MessageCircle, Link2, CalendarClock, Newspaper, Clock,
} from "lucide-react";

const DEFAULT_UPN = process.env.NEXT_PUBLIC_DEFAULT_UPN || "weerasak.pi@ktisgroup.com";

type LineState = { linked: boolean; display_name: string | null; upn: string | null };
type NotifyKindCfg = { enabled: boolean; time: string; days: number[] };
type NotifyCfg = { brief: NotifyKindCfg; news: NotifyKindCfg };

// Thai weekday chips in display order → JS day numbers (0=Sun … 6=Sat)
const DAY_CHIPS: { label: string; d: number }[] = [
  { label: "จ", d: 1 }, { label: "อ", d: 2 }, { label: "พ", d: 3 },
  { label: "พฤ", d: 4 }, { label: "ศ", d: 5 }, { label: "ส", d: 6 }, { label: "อา", d: 0 },
];

function Row({ icon, color, title, subtitle, children }: {
  icon: React.ReactNode; color: string; title: string; subtitle?: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-xl bg-slate-800/60 border border-slate-700">
      <div className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center ${color}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-slate-100 truncate">{title}</div>
        {subtitle && <div className="text-xs text-slate-400 mt-0.5 truncate">{subtitle}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-2">{children}</div>
    </div>
  );
}

function Badge({ ok, on = "เชื่อมต่อแล้ว", off = "ยังไม่ได้เชื่อม" }: { ok: boolean; on?: string; off?: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400"><CheckCircle2 className="w-4 h-4" /> {on}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500"><XCircle className="w-4 h-4" /> {off}</span>
  );
}

function NotifyCard({
  icon, color, title, hint, cfg, disabled, onChange,
}: {
  icon: React.ReactNode; color: string; title: string; hint: string;
  cfg: NotifyKindCfg; disabled?: boolean;
  onChange: (patch: Partial<NotifyKindCfg>) => void;
}) {
  const toggleDay = (d: number) => {
    const has = cfg.days.includes(d);
    onChange({ days: has ? cfg.days.filter((x) => x !== d) : [...cfg.days, d] });
  };
  return (
    <div className={`p-4 rounded-xl bg-slate-800/60 border border-slate-700 space-y-3 ${cfg.enabled ? "" : "opacity-70"}`}>
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center ${color}`}>{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>
        </div>
        <button
          onClick={() => onChange({ enabled: !cfg.enabled })}
          disabled={disabled}
          role="switch"
          aria-checked={cfg.enabled}
          className={`relative w-11 h-6 shrink-0 rounded-full transition ${cfg.enabled ? "bg-emerald-500" : "bg-slate-600"}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition ${cfg.enabled ? "translate-x-5" : ""}`} />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-slate-400" />
        <span className="text-xs text-slate-300">เวลาส่ง</span>
        <input
          type="time"
          value={cfg.time}
          disabled={disabled || !cfg.enabled}
          onChange={(e) => onChange({ time: e.target.value })}
          className="text-sm px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 focus:outline-none focus:border-sky-500 disabled:opacity-50"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {DAY_CHIPS.map(({ label, d }) => {
          const on = cfg.days.includes(d);
          return (
            <button
              key={d}
              onClick={() => toggleDay(d)}
              disabled={disabled || !cfg.enabled}
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

function AccountContent() {
  const { account, login, logout } = useM365Auth();
  const upn = account?.username || DEFAULT_UPN;

  const [line, setLine] = useState<LineState | null>(null);
  const [msg, setMsg] = useState("กำลังโหลด…");
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [confirmLogoutM365, setConfirmLogoutM365] = useState(false);
  const [notify, setNotify] = useState<NotifyCfg | null>(null);

  // 365 = ลงชื่อเข้า/ออกด้วย MSAL เท่านั้น (แยกจากการผูก LINE โดยสิ้นเชิง)
  const m365Connected = !!account;

  const refresh = useCallback(async () => {
    try {
      const [ls, nt] = await Promise.all([
        fetch(`/api/line/status?upn=${encodeURIComponent(upn)}`, { cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/notify?upn=${encodeURIComponent(upn)}`, { cache: "no-store" }).then((r) => r.json()),
      ]);
      setLine({ linked: !!ls.linked, display_name: ls.display_name || null, upn: ls.upn || null });
      if (nt && !nt.error && nt.brief && nt.news) setNotify(nt as NotifyCfg);
      setMsg("");
    } catch (e) {
      setMsg("โหลดไม่สำเร็จ: " + (e as Error).message);
    }
  }, [upn]);

  useEffect(() => { refresh(); }, [refresh]);

  const unlinkLine = async () => {
    setBusy(true);
    try {
      await fetch(`/api/line/link?upn=${encodeURIComponent(upn)}`, { method: "DELETE" });
      setConfirmUnlink(false);
      await refresh();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const saveNotify = async (kind: "brief" | "news", patch: Partial<NotifyKindCfg>) => {
    setNotify((prev) => (prev ? { ...prev, [kind]: { ...prev[kind], ...patch } } : prev));
    try {
      const res = await fetch(`/api/notify?upn=${encodeURIComponent(upn)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ...patch }),
      });
      const data = await res.json();
      if (data && !data.error && data.brief && data.news) setNotify(data as NotifyCfg);
    } catch { /* keep optimistic value */ }
  };

  // ลงชื่อออกจาก 365 เท่านั้น — ไม่ยุ่งกับการผูก LINE
  const logoutM365 = async () => {
    setBusy(true);
    try {
      if (account) await logout();
      setConfirmLogoutM365(false);
    } catch { /* ignore */ }
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-2xl mx-auto space-y-5">
        <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
          <ArrowLeft className="w-4 h-4" /> ตั้งค่า
        </Link>

        <header className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 text-center">
          <h1 className="text-xl font-bold">👤 บัญชีของฉัน</h1>
          <p className="text-xs text-slate-400 mt-1">ดูว่าเชื่อมบัญชีอะไรไว้ อนุญาตติดตามอะไรบ้าง และยกเลิกได้จากที่นี่</p>
          {msg && <p className="text-xs text-rose-400 mt-2">{msg}</p>}
        </header>

        {/* ---- connected accounts ---- */}
        <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2"><Link2 className="w-4 h-4" /> บัญชีที่เชื่อมต่อ</h2>

          <Row icon={<Mail className="w-5 h-5 text-slate-950" />} color="bg-blue-400"
               title="Microsoft 365" subtitle={upn}>
            {m365Connected ? (
              <button onClick={() => setConfirmLogoutM365(true)} disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700">
                <LogOut className="w-4 h-4" /> ลงชื่อออก
              </button>
            ) : (
              <button onClick={() => login()}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white">
                <LogIn className="w-4 h-4" /> เข้าสู่ระบบ
              </button>
            )}
          </Row>

          {confirmLogoutM365 && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-100/90 leading-relaxed space-y-3">
              <div className="font-semibold text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> ลงชื่อออกจาก Microsoft 365?</div>
              <ul className="list-disc list-inside space-y-1">
                <li>จะออกจากระบบ Microsoft 365 และ<b>ใช้งานสรุปประชุม อีเมล ปฏิทิน และงานที่ได้รับมอบหมายไม่ได้</b>จนกว่าจะลงชื่อเข้าใหม่</li>
                <li><b>การผูก LINE ไม่ได้รับผลกระทบ</b> — ยังเชื่อมอยู่เหมือนเดิม</li>
                <li>ลงชื่อเข้าใหม่ได้ทุกเมื่อ</li>
              </ul>
              <div className="flex gap-2">
                <button onClick={logoutM365} disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 font-semibold px-3 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-white">
                  <LogOut className="w-4 h-4" /> ลงชื่อออก
                </button>
                <button onClick={() => setConfirmLogoutM365(false)} disabled={busy}
                  className="flex-1 font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">
                  ไม่ลงชื่อออก
                </button>
              </div>
            </div>
          )}

          <Row icon={<MessageCircle className="w-5 h-5 text-slate-950" />} color="bg-emerald-400"
               title="LINE" subtitle={line?.linked ? (line.display_name || "เชื่อมกับ LINE นี้") : "ยังไม่ได้ผูกกับ LINE"}>
            {line?.linked ? (
              <button onClick={() => setConfirmUnlink(true)} disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700">
                <Unlink className="w-4 h-4" /> ยกเลิก
              </button>
            ) : (
              <Link href="/line-link" className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950">
                ผูกบัญชี
              </Link>
            )}
          </Row>

          {line?.linked && <Badge ok on="สถานะ: เชื่อมต่อแล้ว" />}

          {confirmUnlink && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-100/90 leading-relaxed space-y-3">
              <div className="font-semibold text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> ยกเลิกการผูก LINE?</div>
              <ul className="list-disc list-inside space-y-1">
                <li>จะ<b>ไม่ได้รับ</b>สรุปประชุม งานที่ได้รับมอบหมาย และการแจ้งเตือน ทาง LINE อีก</li>
                <li>จะไม่ได้รับสรุปข่าวที่ติดตาม (digest) ทาง LINE</li>
                <li>ข้อมูลงาน/การตั้งค่าติดตามข่าว <b>ยังอยู่เหมือนเดิม</b> (ลบเฉพาะการเชื่อม LINE)</li>
                <li>ผูกใหม่ได้ทุกเมื่อ</li>
              </ul>
              <div className="flex gap-2">
                <button onClick={unlinkLine} disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 font-semibold px-3 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-white">
                  <Unlink className="w-4 h-4" /> ยืนยันยกเลิก
                </button>
                <button onClick={() => setConfirmUnlink(false)} disabled={busy}
                  className="flex-1 font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">
                  ไม่ยกเลิก
                </button>
              </div>
            </div>
          )}

        </section>

        {/* ---- proactive notification schedule ---- */}
        <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2"><CalendarClock className="w-4 h-4" /> เวลาที่ AI ส่งให้อัตโนมัติ (ทาง LINE)</h2>
          <p className="text-[11px] text-slate-500 leading-relaxed -mt-1">
            ตั้งเวลาและวันที่อยากให้ผู้ช่วยส่ง “สรุปตารางเช้า” และ “สรุปข่าว” เข้ามาใน LINE เอง · ปิด/เปิดแยกกันได้ · บันทึกทันที
          </p>

          {notify ? (
            <>
              <NotifyCard
                icon={<CalendarClock className="w-5 h-5 text-slate-950" />} color="bg-amber-400"
                title="สรุปตารางเช้า (Morning Brief)"
                hint="นัดหมาย/งานของวันนี้"
                cfg={notify.brief} disabled={busy}
                onChange={(patch) => saveNotify("brief", patch)}
              />
              <NotifyCard
                icon={<Newspaper className="w-5 h-5 text-slate-950" />} color="bg-sky-400"
                title="สรุปข่าวที่ติดตาม (News Digest)"
                hint="ข่าว RSS + คลิป YouTube ที่ติดตาม"
                cfg={notify.news} disabled={busy}
                onChange={(patch) => saveNotify("news", patch)}
              />
              <p className="text-[11px] text-slate-500 leading-relaxed">
                ค่าเริ่มต้น: ตาราง จ–ศ 07:00 · ข่าว จ–อา 07:01 (ระบบส่งให้ภายใน ~15 นาทีของเวลาที่ตั้ง)
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-500">กำลังโหลดการตั้งค่า…</p>
          )}
        </section>

        <p className="text-[11px] text-slate-500 text-center leading-relaxed">
          จัดการแหล่งข่าว/ฟีดที่ติดตาม (YouTube · ลิงก์ RSS) ได้ที่หน้า{" "}
          <Link href="/consents" className="text-sky-400 underline">ติดตามข่าว / ฟีด</Link>
        </p>
      </div>
    </div>
  );
}

export default function AccountPage() {
  return (
    <M365AuthProvider>
      <AccountContent />
    </M365AuthProvider>
  );
}
