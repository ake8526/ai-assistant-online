"use client";

import React, { useState } from "react";
import { M365AuthProvider } from "@/components/M365AuthProvider";
import { ShieldCheck, Youtube, Facebook, Rss, Layers, CheckCircle2, ArrowRight, Plus } from "lucide-react";

function ConsentsContent() {
  const [consents, setConsents] = useState({
    src_youtube: true,
    src_facebook: true,
    src_rss: true,
    read_tracking: true,
  });
  const [grantedAll, setGrantedAll] = useState(false);
  const [newFeed, setNewFeed] = useState({ kind: "youtube", ref: "", label: "" });
  const [feedsList, setFeedsList] = useState([
    { kind: "youtube", label: "YouTube Subscriptions", ref: "subscriptions" },
    { kind: "rss", label: "Blognone IT News", ref: "https://www.blognone.com/atom.xml" },
    { kind: "facebook", label: "The Standard Facebook", ref: "https://thestandard.co" },
  ]);

  const toggleConsent = (key: keyof typeof consents) => {
    setConsents((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleGrantAll = () => {
    setConsents({
      src_youtube: true,
      src_facebook: true,
      src_rss: true,
      read_tracking: true,
    });
    setGrantedAll(true);
  };

  const handleAddFeed = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFeed.label || !newFeed.ref) return;
    setFeedsList([...feedsList, { ...newFeed }]);
    setNewFeed({ kind: "youtube", ref: "", label: "" });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl text-center shadow-2xl">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-500/20">
            <ShieldCheck className="w-7 h-7 text-slate-950" />
          </div>
          <h1 className="text-xl font-bold mb-1">📰 ตั้งค่าขอสิทธิ์ข่าวสาร & YouTube</h1>
          <p className="text-xs text-slate-400">
            อนุญาตให้ระบบดึงและสรุปข่าวสาร Facebook, YouTube และ RSS แบบ 4 ขั้นตอนสั้นกระชับ
          </p>
        </div>

        {/* 1-Click Grant All Box */}
        <div className="p-6 rounded-3xl bg-gradient-to-r from-emerald-950/40 via-slate-900 to-slate-900 border border-emerald-500/30 backdrop-blur-xl shadow-xl">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-bold text-emerald-400">⚡ อนุญาตสิทธิ์ทั้งหมดในคลิกเดียว (1-Click)</h2>
              <p className="text-xs text-slate-400 mt-1">
                เปิดใช้งาน YouTube, Facebook, RSS Feeds และระบบ Read Short Link ครบถ้วน
              </p>
            </div>
            <button
              onClick={handleGrantAll}
              className="w-full sm:w-auto px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition shadow-lg shadow-emerald-500/20 shrink-0"
            >
              {grantedAll ? "✅ อนุญาตเรียบร้อยแล้ว!" : "อนุญาตสิทธิ์ทั้งหมด (1-Click)"}
            </button>
          </div>
        </div>

        {/* Individual Toggles */}
        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl space-y-4">
          <h2 className="text-sm font-bold text-slate-200">สิทธิ์แต่ละประเภท</h2>
          <div className="grid gap-3">
            {[
              { key: "src_youtube", label: "YouTube Subscriptions (ดึงช่องที่ติดตาม)", icon: Youtube, color: "text-red-400" },
              { key: "src_facebook", label: "Facebook Page Feeds", icon: Facebook, color: "text-blue-400" },
              { key: "src_rss", label: "RSS Web News Feeds", icon: Rss, color: "text-amber-400" },
              { key: "read_tracking", label: "Read Tracking Short Links (/r/<code>)", icon: Layers, color: "text-emerald-400" },
            ].map(({ key, label, icon: Icon, color }) => (
              <button
                key={key}
                onClick={() => toggleConsent(key as keyof typeof consents)}
                className={`flex items-center justify-between p-4 rounded-xl border text-left transition ${
                  consents[key as keyof typeof consents]
                    ? "bg-slate-800/80 border-slate-700 text-slate-200"
                    : "bg-slate-950/40 border-slate-900 text-slate-500"
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon className={`w-5 h-5 ${color}`} />
                  <span className="text-xs font-semibold">{label}</span>
                </div>
                <CheckCircle2
                  className={`w-5 h-5 ${
                    consents[key as keyof typeof consents] ? "text-emerald-400" : "text-slate-700"
                  }`}
                />
              </button>
            ))}
          </div>

          <div className="pt-4 border-t border-slate-800">
            <button
              onClick={() => alert("กำลังนำไปหน้า Google OAuth สำหรับ YouTube...")}
              className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-xs transition shadow-lg shadow-red-600/20"
            >
              <Youtube className="w-4 h-4" />
              🔴 เชื่อมต่อบัญชี YouTube (Google Login)
            </button>
          </div>
        </div>

        {/* Add Channels / Feeds */}
        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl space-y-4">
          <h2 className="text-sm font-bold text-slate-200">รายการที่ติดตามอยู่ ({feedsList.length})</h2>
          <form onSubmit={handleAddFeed} className="grid sm:grid-cols-3 gap-2">
            <input
              type="text"
              placeholder="ชื่อช่อง/เพจ"
              value={newFeed.label}
              onChange={(e) => setNewFeed({ ...newFeed, label: e.target.value })}
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs focus:outline-none focus:border-emerald-500"
            />
            <input
              type="text"
              placeholder="URL เพจ/ช่อง/RSS"
              value={newFeed.ref}
              onChange={(e) => setNewFeed({ ...newFeed, ref: e.target.value })}
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs focus:outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              className="flex items-center justify-center gap-1 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition"
            >
              <Plus className="w-4 h-4" />
              เพิ่มการติดตาม
            </button>
          </form>

          <div className="divide-y divide-slate-800">
            {feedsList.map((f, i) => (
              <div key={i} className="py-2.5 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  {f.kind === "youtube" && <Youtube className="w-3.5 h-3.5 text-red-400" />}
                  {f.kind === "facebook" && <Facebook className="w-3.5 h-3.5 text-blue-400" />}
                  {f.kind === "rss" && <Rss className="w-3.5 h-3.5 text-amber-400" />}
                  <span className="font-medium text-slate-200">{f.label}</span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono truncate max-w-[150px]">{f.ref}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ConsentsPage() {
  return (
    <M365AuthProvider>
      <ConsentsContent />
    </M365AuthProvider>
  );
}
