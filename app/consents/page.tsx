"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import {
  ArrowLeft, Youtube, Facebook, Rss, Plus, Trash2, Unlink, AlertTriangle,
} from "lucide-react";

const DEFAULT_UPN = process.env.NEXT_PUBLIC_DEFAULT_UPN || "weerasak.pi@ktisgroup.com";

type YtState = { linked: boolean; email: string | null; name: string | null; channel: string | null };
type Feed = { id: number; kind: string; ref: string; label: string };

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

function ConsentsContent() {
  const { account } = useM365Auth();
  const upn = account?.username || DEFAULT_UPN;

  const [yt, setYt] = useState<YtState>({ linked: false, email: null, name: null, channel: null });
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmUnlinkYt, setConfirmUnlinkYt] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [feedMsg, setFeedMsg] = useState("");

  const ytSubtitle = (() => {
    if (yt.linked) {
      const bits = [yt.email, yt.channel ? `ช่อง: ${yt.channel}` : null].filter(Boolean);
      return bits.length ? bits.join(" · ") : (yt.name || "เชื่อม Google/YouTube แล้ว");
    }
    return "กดเชื่อม → เลือกบัญชี Google → อนุญาตสิทธิ์ YouTube";
  })();

  const refresh = useCallback(async () => {
    try {
      const [ys, fs] = await Promise.all([
        fetch(`/api/oauth/google/status?upn=${encodeURIComponent(upn)}`, { cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/feeds?upn=${encodeURIComponent(upn)}`, { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (ys && !ys.error) {
        setYt({ linked: !!ys.linked, email: ys.email || null, name: ys.name || null, channel: ys.channel || null });
      }
      if (Array.isArray(fs)) setFeeds(fs.filter((f: Feed) => f.kind === "rss"));
    } catch (e) {
      setMsg("โหลดไม่สำเร็จ: " + (e as Error).message);
    }
  }, [upn]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const ytParam = new URLSearchParams(window.location.search).get("yt");
    if (!ytParam) return;
    const map: Record<string, string> = {
      connected: "✅ เชื่อม YouTube สำเร็จแล้ว",
      error: "⚠️ เชื่อม YouTube ไม่สำเร็จ ลองอีกครั้ง",
      no_refresh: "⚠️ Google ไม่ส่ง refresh token — ลองยกเลิกสิทธิ์แอปในบัญชี Google แล้วเชื่อมใหม่",
      no_yt_scope: "⚠️ ยังไม่ได้อนุญาตสิทธิ์ดู YouTube — ตอนกดเชื่อม กรุณาติ๊ก “ดูบัญชี YouTube ของคุณ” ด้วย แล้วเชื่อมใหม่ (ถ้ายังไม่ขึ้นให้เลือก ต้องเพิ่ม scope youtube.readonly ใน Google Cloud Console ก่อน)",
      need_google_oauth: "⚠️ ยังไม่ได้ตั้งค่า Google OAuth บนเซิร์ฟเวอร์",
      need_login: "⚠️ กรุณาเข้าสู่ระบบ Microsoft 365 ก่อน",
    };
    setMsg(map[ytParam] || "");
    window.history.replaceState({}, "", "/consents");
    if (ytParam === "connected") refresh();
  }, [refresh]);

  const connectYouTube = () => {
    window.location.href = `/api/oauth/google/start?upn=${encodeURIComponent(upn)}&back=/consents`;
  };

  const unlinkYouTube = async () => {
    setBusy(true);
    try {
      await fetch(`/api/oauth/google/status?upn=${encodeURIComponent(upn)}`, { method: "DELETE" });
      setConfirmUnlinkYt(false);
      setYt({ linked: false, email: null, name: null, channel: null });
      await refresh();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const addFeed = async () => {
    const ref = newUrl.trim();
    setFeedMsg("");
    if (!/^https?:\/\//i.test(ref)) {
      setFeedMsg("ใส่ลิงก์ RSS ที่ขึ้นต้นด้วย http:// หรือ https:// ครับ");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/feeds?upn=${encodeURIComponent(upn)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "rss", ref, label: newLabel.trim() }),
      });
      const data = await res.json();
      if (data?.error) {
        setFeedMsg("เพิ่มไม่สำเร็จ: " + data.error);
      } else {
        // ต้องอนุญาตแหล่ง RSS ให้ระบบดึงมาสรุป (เปิดให้อัตโนมัติเมื่อเพิ่มลิงก์แรก)
        await fetch(`/api/consents?upn=${encodeURIComponent(upn)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capability: "src_rss", granted: true }),
        });
        setNewUrl("");
        setNewLabel("");
        await refresh();
      }
    } catch (e) {
      setFeedMsg("เพิ่มไม่สำเร็จ: " + (e as Error).message);
    }
    setBusy(false);
  };

  const removeFeed = async (id: number) => {
    setBusy(true);
    try {
      await fetch(`/api/feeds?upn=${encodeURIComponent(upn)}&id=${id}`, { method: "DELETE" });
      await refresh();
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
          <h1 className="text-xl font-bold">📰 ติดตามข่าว / ฟีด</h1>
          <p className="text-xs text-slate-400 mt-1">เลือกแหล่งข่าวให้ผู้ช่วยไปดึงมาสรุปให้ · ถามในแชทได้ว่า “มีข่าวอะไรบ้าง”</p>
          {msg && <p className="text-xs text-amber-300 mt-2">{msg}</p>}
        </header>

        <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2"><Rss className="w-4 h-4" /> การอนุญาตติดตามข่าว</h2>

          <Row icon={<Youtube className="w-5 h-5 text-slate-950" />} color="bg-red-500"
               title="YouTube" subtitle={ytSubtitle}>
            {yt.linked ? (
              <button onClick={() => setConfirmUnlinkYt(true)} disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700">
                <Unlink className="w-4 h-4" /> ยกเลิก
              </button>
            ) : (
              <button onClick={connectYouTube} disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white">
                เชื่อมบัญชี
              </button>
            )}
          </Row>

          {confirmUnlinkYt && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-100/90 leading-relaxed space-y-3">
              <div className="font-semibold text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> ยกเลิกการเชื่อม YouTube?</div>
              <ul className="list-disc list-inside space-y-1">
                <li>ระบบจะ<b>ไม่ดึง</b>ช่องที่คุณ subscribe มาสรุปข่าวอีก</li>
                <li>เชื่อมใหม่ได้ทุกเมื่อ (จะให้เลือกบัญชี Google อีกครั้ง)</li>
              </ul>
              <div className="flex gap-2">
                <button onClick={unlinkYouTube} disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 font-semibold px-3 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-white">
                  <Unlink className="w-4 h-4" /> ยืนยันยกเลิก
                </button>
                <button onClick={() => setConfirmUnlinkYt(false)} disabled={busy}
                  className="flex-1 font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">
                  ไม่ยกเลิก
                </button>
              </div>
            </div>
          )}

          <Row icon={<Facebook className="w-5 h-5 text-slate-950" />} color="bg-blue-500"
               title="Facebook" subtitle="ยังดึงเพจที่ติดตามอัตโนมัติไม่ได้ (ข้อจำกัด Facebook API)">
            <span className="text-xs text-slate-600">ไม่พร้อมใช้</span>
          </Row>

          {/* custom RSS links — add as many as you like */}
          <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Rss className="w-4 h-4 text-amber-400" /> ลิงก์ข่าว/บล็อก (RSS) ที่ติดตาม
            </div>

            {feeds.length === 0 ? (
              <p className="text-xs text-slate-500">ยังไม่มีลิงก์ที่ติดตาม — เพิ่มลิงก์ RSS ด้านล่างได้เลย</p>
            ) : (
              <ul className="space-y-2">
                {feeds.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-200 truncate">{f.label || f.ref}</div>
                      {f.label && <div className="text-[11px] text-slate-500 truncate">{f.ref}</div>}
                    </div>
                    <button onClick={() => removeFeed(f.id)} disabled={busy}
                      className="shrink-0 p-2 rounded-lg text-rose-300 hover:bg-slate-800 border border-slate-700" aria-label="ลบลิงก์">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-2">
              <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addFeed(); }}
                placeholder="วางลิงก์ RSS เช่น https://www.blognone.com/atom.xml"
                className="w-full text-xs px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500" />
              <div className="flex gap-2">
                <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addFeed(); }}
                  placeholder="ชื่อย่อ (ไม่ใส่ก็ได้)"
                  className="flex-1 text-xs px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500" />
                <button onClick={addFeed} disabled={busy || !newUrl.trim()}
                  className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 disabled:opacity-50">
                  <Plus className="w-4 h-4" /> เพิ่ม
                </button>
              </div>
              {feedMsg && <p className="text-[11px] text-rose-400">{feedMsg}</p>}
              <p className="text-[11px] text-slate-500 leading-relaxed">
                ใส่ลิงก์ฟีด RSS/Atom ของเว็บข่าวหรือบล็อกที่อยากติดตาม เพิ่มได้ไม่จำกัด · ระบบจะดึงมาสรุปรวมกับ YouTube ให้
              </p>
            </div>
          </div>
        </section>
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
