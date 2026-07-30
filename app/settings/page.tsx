"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import {
  Settings as SettingsIcon,
  MapPin,
  Clock,
  Save,
  CheckCircle2,
  LogIn,
  ArrowLeft,
  UserCircle2,
  Rss,
  MessageCircle,
  LogOut,
} from "lucide-react";

const MENU = [
  {
    href: "/account",
    icon: UserCircle2,
    title: "บัญชีของฉัน",
    desc: "ดูบัญชีที่เชื่อมต่อ (Microsoft 365 / LINE) และการอนุญาต",
    accent: "from-emerald-500 to-teal-400",
  },
  {
    href: "/consents",
    icon: Rss,
    title: "ติดตามข่าว / ฟีด",
    desc: "เลือกอนุญาตแหล่งข่าว และดูสรุปข่าวที่ติดตาม",
    accent: "from-sky-500 to-indigo-400",
  },
];

function SettingsContent() {
  const { account, login, logout, getToken } = useM365Auth();
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState("");
  const [workLocation, setWorkLocation] = useState("");
  const [homeLocation, setHomeLocation] = useState("");
  const [workHours, setWorkHours] = useState({ start: "09:00", end: "17:00" });

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const d = await fetch("/api/settings", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
      if (d && !d.error) {
        setWorkHours({ start: d.work_start, end: d.work_end });
        setWorkLocation(d.work_location);
        setHomeLocation(d.home_location);
        setMsg("");
      }
    } catch {
      setMsg("โหลดการตั้งค่าไม่สำเร็จ");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const hhmm = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!hhmm.test(workHours.start) || !hhmm.test(workHours.end)) {
      setMsg("เวลาต้องเป็นรูปแบบ 24 ชม. เช่น 09:00 หรือ 17:00");
      return;
    }
    const token = await getToken();
    if (!token) {
      setMsg("กรุณาเข้าสู่ระบบ M365 ก่อนบันทึก");
      return;
    }
    try {
      const d = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          work_start: workHours.start,
          work_end: workHours.end,
          work_location: workLocation,
          home_location: homeLocation,
        }),
      }).then((r) => r.json());
      if (d.error) {
        setMsg(`บันทึกไม่สำเร็จ: ${d.error}`);
        return;
      }
      setMsg("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setMsg(`บันทึกไม่สำเร็จ: ${(err as Error).message}`);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-slate-400 hover:text-slate-200 p-1">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold">ตั้งค่า</h1>
            <p className="text-[11px] text-slate-500 truncate">
              {account?.username || "ยังไม่ได้เข้าสู่ระบบ"}
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-slate-950"
          >
            <MessageCircle className="w-4 h-4" /> แชท
          </Link>
        </div>

        {/* Menu hub */}
        <div className="space-y-3">
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide px-1">เมนู</p>
          {MENU.map((f) => (
            <Link
              key={f.href}
              href={f.href}
              className="flex items-center gap-4 p-4 rounded-2xl bg-slate-900/80 border border-slate-800 hover:border-slate-600 transition group"
            >
              <div className={`w-11 h-11 shrink-0 rounded-xl bg-gradient-to-tr ${f.accent} flex items-center justify-center`}>
                <f.icon className="w-5 h-5 text-slate-950" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">{f.title}</div>
                <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">{f.desc}</div>
              </div>
            </Link>
          ))}
        </div>

        {!account ? (
          <button
            onClick={() => login()}
            className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs transition"
          >
            <LogIn className="w-4 h-4" />
            เข้าสู่ระบบ Microsoft 365
          </button>
        ) : (
          <button
            onClick={() => logout()}
            className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-rose-500/40 text-rose-300 font-semibold text-xs transition"
          >
            <LogOut className="w-4 h-4" />
            ออกจากระบบ Microsoft 365
          </button>
        )}

        {msg && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs text-center">{msg}</div>
        )}

        <form onSubmit={handleSave} className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl space-y-5">
          <div className="flex items-center gap-2 mb-1">
            <SettingsIcon className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold">เวลาทำงาน & สถานที่</h2>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-2">
              <Clock className="w-4 h-4 text-emerald-400" />
              เวลาเข้า-เลิกงาน
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-[10px] text-slate-500">เวลาเริ่มงาน (เช่น 09:00)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="09:00"
                  pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                  maxLength={5}
                  value={workHours.start}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d:]/g, "").slice(0, 5);
                    setWorkHours({ ...workHours, start: v });
                  }}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 tabular-nums"
                />
              </div>
              <div>
                <span className="text-[10px] text-slate-500">เวลาเลิกงาน (เช่น 17:00)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="17:00"
                  pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                  maxLength={5}
                  value={workHours.end}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d:]/g, "").slice(0, 5);
                    setWorkHours({ ...workHours, end: v });
                  }}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 tabular-nums"
                />
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div>
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-2 mb-1">
                <MapPin className="w-4 h-4 text-blue-400" />
                สถานที่ทำงาน
              </label>
              <input
                type="text"
                value={workLocation}
                onChange={(e) => setWorkLocation(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-2 mb-1">
                <MapPin className="w-4 h-4 text-amber-400" />
                บ้าน / ที่พัก
              </label>
              <input
                type="text"
                value={homeLocation}
                onChange={(e) => setHomeLocation(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <button
            type="submit"
            className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition shadow-lg shadow-emerald-500/20"
          >
            {saved ? (
              <>
                <CheckCircle2 className="w-4 h-4" />
                บันทึกการตั้งค่าเรียบร้อยแล้ว!
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                บันทึกข้อมูล
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <M365AuthProvider>
      <SettingsContent />
    </M365AuthProvider>
  );
}
