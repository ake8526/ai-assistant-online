"use client";

import React, { useEffect, useState, useCallback } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { ShieldCheck, Youtube, Facebook, Rss, Layers, CheckCircle2, Plus, Trash2 } from "lucide-react";

const DEFAULT_UPN = process.env.NEXT_PUBLIC_DEFAULT_UPN || "weerasak.pi@ktisgroup.com";
type Caps = { src_youtube: boolean; src_facebook: boolean; src_rss: boolean; read_tracking: boolean };
type Feed = { id?: number; kind: string; ref: string; label: string };

const CAP_ROWS = [
  { key: "src_youtube", label: "YouTube Subscriptions (ดึงช่องที่ติดตาม)", icon: Youtube, color: "text-red-400" },
  { key: "src_facebook", label: "Facebook Page Feeds", icon: Facebook, color: "text-blue-400" },
  { key: "src_rss", label: "RSS Web News Feeds", icon: Rss, color: "text-amber-400" },
  { key: "read_tracking", label: "Read Tracking Short Links (/r/<code>)", icon: Layers, color: "text-emerald-400" },
] as const;

function ConsentsContent() {
  const { account } = useM365Auth();
  const upn = account?.username || DEFAULT_UPN;

  const [consents, setConsents] = useState<Caps>({ src_youtube: false, src_facebook: false, src_rss: false, read_tracking: false });
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [newFeed, setNewFeed] = useState<Feed>({ kind: "rss", ref: "", label: "" });
  const [msg, setMsg] = useState("กำลังโหลด…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, f] = await Promise.all([
        fetch(`/api/consents?upn=${encodeURIComponent(upn)}`).then((r) => r.json()),
        fetch(`/api/feeds?upn=${encodeURIComponent(upn)}`).then((r) => r.json()),
      ]);
      if (c && !c.error) setConsents(c);
      if (Array.isArray(f)) setFeeds(f);
      setMsg(`บัญชี: ${upn}`);
    } catch (e) {
      setMsg("โหลดไม่สำเร็จ: " + (e as Error).message);
    }
  }, [upn]);

  useEffect(() => { refresh(); }, [refresh]);

  const setConsent = async (capability: keyof Caps, granted: boolean) => {
    setBusy(true);
    setConsents((p) => ({ ...p, [capability]: granted })); // optimistic
    try {
      const res = await fetch(`/api/consents?upn=${encodeURIComponent(upn)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability, granted }),
      });
      const data = await res.json();
      if (data && !data.error) setConsents(data);
    } catch { /* keep optimistic */ }
    setBusy(false);
  };

  const grantAll = async () => {
    setBusy(true);
    for (const { key } of CAP_ROWS) {
      await fetch(`/api/consents?upn=${encodeURIComponent(upn)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: key, granted: true }),
      });
    }
    await refresh();
    setBusy(false);
  };

  const addFeed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFeed.ref.trim()) return;
    setBusy(true);
    const res = await fetch(`/api/feeds?upn=${encodeURIComponent(upn)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newFeed),
    });
    const data = await res.json();
    if (data.error) setMsg("เพิ่มไม่สำเร็จ: " + data.error);
    else { setNewFeed({ kind: "rss", ref: "", label: "" }); await refresh(); }
    setBusy(false);
  };

  const removeFeed = async (id?: number) => {
    if (!id) return;
    setBusy(true);
    await fetch(`/api/feeds?upn=${encodeURIComponent(upn)}&id=${id}`, { method: "DELETE" });
    await refresh();
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 text-center shadow-2xl">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-4">
            <ShieldCheck className="w-7 h-7 text-slate-950" />
          </div>
          <h1 className="text-xl font-bold mb-1">📰 ติดตามข่าว — ตั้งค่าสิทธิ์ & แหล่งข่าว</h1>
          <p className="text-xs text-slate-400">{msg}</p>
        </div>

        <div className="p-6 rounded-3xl bg-gradient-to-r from-emerald-950/40 via-slate-900 to-slate-900 border border-emerald-500/30">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-bold text-emerald-400">⚡ อนุญาตสิทธิ์ทั้งหมดในคลิกเดียว</h2>
              <p className="text-xs text-slate-400 mt-1">เปิด YouTube, Facebook, RSS และ Read Tracking ครบ</p>
            </div>
            <button onClick={grantAll} disabled={busy} className="w-full sm:w-auto px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shrink-0 disabled:opacity-60">
              อนุญาตทั้งหมด (1-Click)
            </button>
          </div>
        </div>

        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-4">
          <h2 className="text-sm font-bold text-slate-200">สิทธิ์แต่ละประเภท (กดเพื่อเปิด/ปิด — บันทึกทันที)</h2>
          <div className="grid gap-3">
            {CAP_ROWS.map(({ key, label, icon: Icon, color }) => {
              const on = consents[key as keyof Caps];
              return (
                <button key={key} onClick={() => setConsent(key as keyof Caps, !on)} disabled={busy}
                  className={`flex items-center justify-between p-4 rounded-xl border text-left transition ${on ? "bg-slate-800/80 border-slate-700 text-slate-200" : "bg-slate-950/40 border-slate-900 text-slate-500"}`}>
                  <div className="flex items-center gap-3">
                    <Icon className={`w-5 h-5 ${color}`} />
                    <span className="text-xs font-semibold">{label}</span>
                  </div>
                  <CheckCircle2 className={`w-5 h-5 ${on ? "text-emerald-400" : "text-slate-700"}`} />
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500">
            YouTube ต้องเชื่อม Google เพิ่ม (ยังไม่ได้ตั้งค่า) · Facebook ให้ใช้ RSS ของเว็บเพจนั้น
          </p>
        </div>

        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-4">
          <h2 className="text-sm font-bold text-slate-200">แหล่งที่ติดตาม ({feeds.length})</h2>
          <form onSubmit={addFeed} className="grid sm:grid-cols-4 gap-2">
            <select value={newFeed.kind} onChange={(e) => setNewFeed({ ...newFeed, kind: e.target.value })}
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs">
              <option value="rss">RSS</option>
              <option value="youtube">YouTube</option>
              <option value="facebook">Facebook</option>
            </select>
            <input type="text" placeholder="ชื่อ (label)" value={newFeed.label}
              onChange={(e) => setNewFeed({ ...newFeed, label: e.target.value })}
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs focus:outline-none focus:border-emerald-500" />
            <input type="text" placeholder="URL (RSS) / subscriptions" value={newFeed.ref}
              onChange={(e) => setNewFeed({ ...newFeed, ref: e.target.value })}
              className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs focus:outline-none focus:border-emerald-500" />
            <button type="submit" disabled={busy} className="flex items-center justify-center gap-1 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs disabled:opacity-60">
              <Plus className="w-4 h-4" /> เพิ่ม
            </button>
          </form>
          <div className="divide-y divide-slate-800">
            {feeds.length === 0 && <p className="text-xs text-slate-500 py-2">ยังไม่มีแหล่งข่าว — เพิ่ม RSS ด้านบน</p>}
            {feeds.map((f) => (
              <div key={f.id} className="py-2.5 flex items-center justify-between text-xs gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {f.kind === "youtube" && <Youtube className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                  {f.kind === "facebook" && <Facebook className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
                  {f.kind === "rss" && <Rss className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                  <span className="font-medium text-slate-200 truncate">{f.label || f.ref}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-slate-500 font-mono truncate max-w-[130px] hidden sm:inline">{f.ref}</span>
                  <button onClick={() => removeFeed(f.id)} disabled={busy} className="text-slate-500 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                </div>
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
