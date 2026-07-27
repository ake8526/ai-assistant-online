"use client";

import React, { useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { Story } from "@/app/api/digest/route";
import {
  Sparkles,
  Youtube,
  Facebook,
  Rss,
  CheckCircle2,
  ExternalLink,
  ShieldCheck,
  Plus,
  RefreshCw,
  UserCheck,
  LogIn,
  LogOut,
  Layers,
  ArrowRight,
  Settings as SettingsIcon,
  MapPin,
  Clock,
  Save,
} from "lucide-react";

function MainApp() {
  const { account, login, logout, isAuthenticated } = useM365Auth();
  const [activeTab, setActiveTab] = useState<"digest" | "link" | "consents" | "settings">("digest");
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [lineLinked, setLineLinked] = useState(false);
  const [consents, setConsents] = useState({
    src_youtube: true,
    src_facebook: true,
    src_rss: true,
    read_tracking: true,
  });
  const [grantedAll, setGrantedAll] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get("tab");
      if (tabParam === "link") setActiveTab("link");
      else if (tabParam === "consents") setActiveTab("consents");
      else if (tabParam === "settings") setActiveTab("settings");
    }
  }, []);

  const fetchDigest = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/digest?upn=${encodeURIComponent(account?.username || "demo@company.com")}`);
      const data = await res.json();
      if (data.stories) {
        setStories(data.stories);
      }
    } catch (err) {
      console.error("Failed to load digest:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDigest();
  }, [account]);

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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-emerald-500 selection:text-white">
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-emerald-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-blue-500/10 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-4 py-8">
        {/* Header Bar */}
        <header className="flex flex-wrap items-center justify-between gap-4 p-6 rounded-2xl bg-slate-900/60 border border-slate-800 backdrop-blur-xl mb-6 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Sparkles className="w-6 h-6 text-slate-950" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                AI Assistant Online
              </h1>
              <p className="text-xs text-slate-400">ระบบติดตามและสรุปข่าวสาร Facebook & YouTube 4 ขั้นตอน</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <div className="flex items-center gap-3 bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-700">
                <UserCheck className="w-4 h-4 text-emerald-400" />
                <div className="text-xs">
                  <p className="font-semibold text-slate-200">{account?.name || "Microsoft 365 User"}</p>
                  <p className="text-slate-400 text-[10px]">{account?.username}</p>
                </div>
                <button onClick={logout} className="ml-2 text-slate-400 hover:text-red-400 transition" title="ออกจากระบบ">
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={login}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition shadow-lg shadow-blue-600/20"
              >
                <LogIn className="w-4 h-4" />
                เข้าสู่ระบบด้วย Microsoft 365
              </button>
            )}
          </div>
        </header>

        {/* Navigation Tabs */}
        <nav className="flex items-center gap-2 mb-8 p-1.5 rounded-xl bg-slate-900/80 border border-slate-800 w-fit">
          {[
            { id: "digest", label: "📰 สรุปข่าวเด่น" },
            { id: "link", label: "🔗 ผูกบัญชี 365" },
            { id: "consents", label: "🛡️ สิทธิ์ข่าวสาร & YT" },
            { id: "settings", label: "⚙️ ตั้งค่าทั่วไป" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition ${
                activeTab === tab.id
                  ? "bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* TAB 1: LINE LINK */}
        {activeTab === "link" && (
          <section className="max-w-xl mx-auto p-8 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl text-center shadow-2xl">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-6 shadow-lg shadow-emerald-500/20">
              <UserCheck className="w-8 h-8 text-slate-950" />
            </div>
            <h2 className="text-xl font-bold mb-2">🔗 ผูกบัญชี Microsoft 365 กับ LINE</h2>
            <p className="text-xs text-slate-400 mb-6 leading-relaxed">
              ผูกบัญชีเพื่อรับการแจ้งเตือน สรุปประชุม งานที่ได้รับมอบหมาย และสรุปเตรียมตัวล่วงหน้าผ่าน LINE โดยตรง
            </p>

            {isAuthenticated ? (
              <div className="p-4 rounded-xl bg-slate-800/80 border border-slate-700 mb-6 text-left">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-slate-200">{account?.name}</p>
                    <p className="text-[11px] text-slate-400">{account?.username}</p>
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={login}
                className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm mb-6 transition shadow-lg shadow-blue-600/20"
              >
                <LogIn className="w-4 h-4" />
                1. เข้าสู่ระบบ Microsoft 365
              </button>
            )}

            <button
              onClick={() => setLineLinked(true)}
              disabled={lineLinked}
              className={`w-full flex items-center justify-center gap-2 p-3.5 rounded-xl font-semibold text-sm transition shadow-lg ${
                lineLinked
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20"
              }`}
            >
              {lineLinked ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  ผูกบัญชีสำเร็จเรียบร้อย!
                </>
              ) : (
                <>
                  2. กดผูกบัญชีกับ LINE (1-Click)
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </section>
        )}

        {/* TAB 2: CONSENTS */}
        {activeTab === "consents" && (
          <section className="max-w-2xl mx-auto space-y-6">
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
          </section>
        )}

        {/* TAB 3: SETTINGS */}
        {activeTab === "settings" && (
          <section className="max-w-xl mx-auto p-6 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl space-y-5">
            <h2 className="text-base font-bold text-slate-200 flex items-center gap-2">
              <SettingsIcon className="w-5 h-5 text-emerald-400" />
              ตั้งค่าทั่วไป (General Settings)
            </h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">สถานที่ทำงาน (Work Location)</label>
                <input
                  type="text"
                  defaultValue="199 หมู่ 2 ต.หนองโพ อ.ตาคลี จ.นครสวรรค์"
                  className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">บ้าน / ที่พัก (Home Location)</label>
                <input
                  type="text"
                  defaultValue="55 หมู่บ้านสุขใจ"
                  className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none"
                />
              </div>
            </div>
          </section>
        )}

        {/* TAB 0: DIGEST */}
        {activeTab === "digest" && (
          <section className="space-y-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                  ⭐ สรุปข่าวเด่น 4 ขั้นตอน (Facebook & YouTube Digest)
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  สรุปสั้นกระชับ: เกิดอะไรขึ้น → สาเหตุ → สถานการณ์ → จบอย่างไร พร้อมลิงค์สั้น
                </p>
              </div>
              <button
                onClick={fetchDigest}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-emerald-400" : ""}`} />
                รีเฟรชข้อมูล
              </button>
            </div>

            <div className="grid gap-6">
              {stories.map((story, idx) => (
                <article
                  key={story.id || idx}
                  className="p-6 rounded-2xl bg-slate-900/70 border border-slate-800 backdrop-blur-xl hover:border-slate-700 transition shadow-xl group"
                >
                  <div className="flex items-center justify-between gap-4 mb-3">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {story.kind === "youtube" && <Youtube className="w-3.5 h-3.5 text-red-400" />}
                      {story.kind === "facebook" && <Facebook className="w-3.5 h-3.5 text-blue-400" />}
                      {story.kind === "rss" && <Rss className="w-3.5 h-3.5 text-amber-400" />}
                      {story.source}
                    </span>
                    <span className="text-[11px] text-slate-500">เรื่องที่ {idx + 1}</span>
                  </div>

                  <h3 className="text-base font-bold text-slate-100 mb-4 group-hover:text-emerald-400 transition">
                    {story.title}
                  </h3>

                  <div className="grid gap-2.5 text-xs mb-5 bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
                    <div className="flex items-start gap-2">
                      <span className="font-semibold text-emerald-400 shrink-0 w-24">📌 เกิดอะไรขึ้น:</span>
                      <p className="text-slate-300 leading-relaxed">{story.whatHappened}</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-semibold text-amber-400 shrink-0 w-24">🔍 สาเหตุ/ที่มา:</span>
                      <p className="text-slate-300 leading-relaxed">{story.cause}</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-semibold text-blue-400 shrink-0 w-24">🔄 เป็นยังไงต่อ:</span>
                      <p className="text-slate-300 leading-relaxed">{story.progress}</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-semibold text-purple-400 shrink-0 w-24">🏁 บทสรุป:</span>
                      <p className="text-slate-300 leading-relaxed">{story.conclusion}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-800/60">
                    <a
                      href={story.rawLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 font-medium transition"
                    >
                      🔗 อ่านต่อ / ชมคลิปเต็ม
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <M365AuthProvider>
      <MainApp />
    </M365AuthProvider>
  );
}
