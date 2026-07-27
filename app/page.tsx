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
} from "lucide-react";

function MainApp() {
  const { account, login, logout, isAuthenticated } = useM365Auth();
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [consents, setConsents] = useState({
    src_youtube: true,
    src_facebook: true,
    src_rss: true,
    read_tracking: true,
  });
  const [newFeed, setNewFeed] = useState({ kind: "youtube", ref: "", label: "" });

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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-emerald-500 selection:text-white">
      {/* Background Glow Overlay */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-emerald-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-blue-500/10 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-4 py-8">
        {/* Header Bar */}
        <header className="flex flex-wrap items-center justify-between gap-4 p-6 rounded-2xl bg-slate-900/60 border border-slate-800 backdrop-blur-xl mb-8 shadow-2xl">
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
                <button
                  onClick={logout}
                  className="ml-2 text-slate-400 hover:text-red-400 transition"
                  title="ออกจากระบบ"
                >
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

        {/* 1-Click Consent & Status Card */}
        <section className="p-6 rounded-2xl bg-gradient-to-r from-slate-900/80 via-slate-900/40 to-slate-900/80 border border-slate-800 backdrop-blur-xl mb-8 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
              <h2 className="font-semibold text-base text-slate-200">1-Click Consent & การจัดการสิทธิ์</h2>
            </div>
            <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
              สิทธิ์พร้อมใช้งาน
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { key: "src_youtube", label: "YouTube Subscriptions", icon: Youtube, color: "text-red-400" },
              { key: "src_facebook", label: "Facebook Feeds", icon: Facebook, color: "text-blue-400" },
              { key: "src_rss", label: "RSS News Feeds", icon: Rss, color: "text-amber-400" },
              { key: "read_tracking", label: "Read Link Tracking", icon: Layers, color: "text-emerald-400" },
            ].map(({ key, label, icon: Icon, color }) => (
              <button
                key={key}
                onClick={() => toggleConsent(key as keyof typeof consents)}
                className={`flex items-center justify-between p-3 rounded-xl border text-left transition ${
                  consents[key as keyof typeof consents]
                    ? "bg-slate-800/80 border-slate-700 text-slate-200"
                    : "bg-slate-950/40 border-slate-900 text-slate-500"
                }`}
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <Icon className={`w-4 h-4 shrink-0 ${color}`} />
                  <span className="text-xs font-medium truncate">{label}</span>
                </div>
                <CheckCircle2
                  className={`w-4 h-4 shrink-0 ${
                    consents[key as keyof typeof consents] ? "text-emerald-400" : "text-slate-700"
                  }`}
                />
              </button>
            ))}
          </div>
        </section>

        {/* Featured News Digest Section */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-6">
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

          {loading ? (
            <div className="p-12 text-center rounded-2xl bg-slate-900/40 border border-slate-800">
              <RefreshCw className="w-8 h-8 animate-spin text-emerald-400 mx-auto mb-3" />
              <p className="text-sm text-slate-400">กำลังรวบรวมข่าวสารจาก Facebook และ YouTube…</p>
            </div>
          ) : (
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

                  {/* 4-Step Story Breakdown */}
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
                    <span className="text-[10px] text-slate-500 font-mono">Short Code: {story.shortLink}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
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
