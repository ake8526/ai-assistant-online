"use client";

import React from "react";
import Link from "next/link";
import { UserCircle2, Rss, Settings as SettingsIcon, ArrowRight } from "lucide-react";

const FEATURES = [
  {
    href: "/account",
    icon: UserCircle2,
    title: "บัญชีของฉัน",
    desc: "ดูบัญชีที่เชื่อมต่อ (Microsoft 365 / LINE) และการอนุญาตติดตามข่าว พร้อมยกเลิกได้จากที่เดียว",
    accent: "from-emerald-500 to-teal-400",
  },
  {
    href: "/consents",
    icon: Rss,
    title: "ติดตามข่าว / ฟีด",
    desc: "เลือกอนุญาตแหล่งข่าว (RSS / YouTube) และดูสรุปข่าวที่คุณติดตามแบบย่อเข้าใจง่าย",
    accent: "from-sky-500 to-indigo-400",
  },
  {
    href: "/settings",
    icon: SettingsIcon,
    title: "ตั้งค่า",
    desc: "ตั้งค่าเวลาทำงาน สถานที่ และการแจ้งเตือนต่าง ๆ",
    accent: "from-fuchsia-500 to-purple-400",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-5 md:p-10 font-sans">
      <div className="max-w-2xl mx-auto">
        <header className="text-center mb-8">
          <div className="text-3xl font-bold tracking-tight">🤖 AI Assistant</div>
          <p className="text-sm text-slate-400 mt-2">ผู้ช่วยงานประจำวัน KTIS — เลือกฟีเจอร์ที่ต้องการด้านล่าง</p>
        </header>

        <div className="space-y-4">
          {FEATURES.map((f) => (
            <Link
              key={f.href}
              href={f.href}
              className="flex items-center gap-4 p-5 rounded-2xl bg-slate-900/80 border border-slate-800 hover:border-slate-600 transition group"
            >
              <div className={`w-12 h-12 shrink-0 rounded-xl bg-gradient-to-tr ${f.accent} flex items-center justify-center`}>
                <f.icon className="w-6 h-6 text-slate-950" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{f.title}</div>
                <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">{f.desc}</div>
              </div>
              <ArrowRight className="w-5 h-5 text-slate-500 group-hover:text-slate-200 transition shrink-0" />
            </Link>
          ))}
        </div>

        <p className="text-center text-[11px] text-slate-600 mt-8">
          ปลอดภัยตามมาตรฐาน PDPA · เก็บ/ดึงข้อมูลเฉพาะที่คุณอนุญาตเท่านั้น
        </p>
      </div>
    </div>
  );
}
