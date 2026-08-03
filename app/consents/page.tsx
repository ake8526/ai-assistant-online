"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import {
  ArrowLeft, Youtube, Facebook, Rss, Plus, Trash2, Unlink, AlertTriangle,
  CalendarClock, Newspaper, Clock, LogIn,
} from "lucide-react";

type YtState = { linked: boolean; email: string | null; name: string | null; channel: string | null };
type Feed = { id: number; kind: string; ref: string; label: string };
type NotifyKindCfg = { enabled: boolean; time: string; days: number[]; count?: number };
type NotifyCfg = { brief: NotifyKindCfg; news: NotifyKindCfg };
type PreviewItem = { title: string; link: string; published: string; summary: string };
type PreviewState = {
  kind: "rss" | "facebook";
  url: string;
  label: string;
  source: string;
  items: PreviewItem[];
};

const DAY_CHIPS: { label: string; d: number }[] = [
  { label: "จ", d: 1 }, { label: "อ", d: 2 }, { label: "พ", d: 3 },
  { label: "พฤ", d: 4 }, { label: "ศ", d: 5 }, { label: "ส", d: 6 }, { label: "อา", d: 0 },
];

function NotifyCard({
  icon, color, title, hint, cfg, disabled, onChange, showCount,
}: {
  icon: React.ReactNode; color: string; title: string; hint: string;
  cfg: NotifyKindCfg; disabled?: boolean; showCount?: boolean;
  onChange: (patch: Partial<NotifyKindCfg>) => void;
}) {
  const toggleDay = (d: number) => {
    const has = cfg.days.includes(d);
    onChange({ days: has ? cfg.days.filter((x) => x !== d) : [...cfg.days, d] });
  };
  const [hh, mm] = (cfg.time || "07:00").split(":");
  const setPart = (h: string, m: string) => onChange({ time: `${h.padStart(2, "0")}:${m.padStart(2, "0")}` });
  const selCls = "text-sm px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 focus:outline-none focus:border-sky-500 disabled:opacity-50";
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
        <select value={hh} disabled={disabled || !cfg.enabled} onChange={(e) => setPart(e.target.value, mm)} className={selCls} aria-label="ชั่วโมง">
          {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
        <span className="text-slate-400 font-semibold">:</span>
        <select value={mm} disabled={disabled || !cfg.enabled} onChange={(e) => setPart(hh, e.target.value)} className={selCls} aria-label="นาที">
          {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <span className="text-[11px] text-slate-500">น. (24 ชม.)</span>
      </div>

      {showCount && (
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-slate-400" />
          <span className="text-xs text-slate-300">จำนวนข่าวต่อวัน</span>
          <select
            value={String(cfg.count ?? 3)}
            disabled={disabled || !cfg.enabled}
            onChange={(e) => onChange({ count: Number(e.target.value) })}
            className={selCls}
            aria-label="จำนวนข่าวต่อวัน"
          >
            <option value={0}>ทั้งหมด (เฉพาะที่อัปเดตวันนี้)</option>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n} ข่าว</option>
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
  const { account, login, getToken, reauth, ready } = useM365Auth();
  const upn = account?.username || "";

  const [yt, setYt] = useState<YtState>({ linked: false, email: null, name: null, channel: null });
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [needReauth, setNeedReauth] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmUnlinkYt, setConfirmUnlinkYt] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [fbUrl, setFbUrl] = useState("");
  const [fbLabel, setFbLabel] = useState("");
  const [feedMsg, setFeedMsg] = useState("");
  const [fbMsg, setFbMsg] = useState("");
  const [notify, setNotify] = useState<NotifyCfg | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const ytSubtitle = (() => {
    if (yt.linked) {
      const bits = [yt.email, yt.channel ? `ช่อง: ${yt.channel}` : null].filter(Boolean);
      return bits.length ? bits.join(" · ") : (yt.name || "เชื่อม Google/YouTube แล้ว");
    }
    return "กดเชื่อม → เลือกบัญชี Google → อนุญาตสิทธิ์ YouTube";
  })();

  const rssFeeds = feeds.filter((f) => f.kind === "rss");
  const fbFeeds = feeds.filter((f) => f.kind === "facebook");

  const authHeaders = useCallback(async (): Promise<HeadersInit | null> => {
    const token = await getToken();
    if (!token) return null;
    return { Authorization: `Bearer ${token}` };
  }, [getToken]);

  const refresh = useCallback(async () => {
    if (!account) {
      setMsg("กรุณาเข้าสู่ระบบ Microsoft 365 ก่อนจัดการแหล่งข่าว");
      setNeedReauth(false);
      setLoadFailed(false);
      setNotify(null);
      return;
    }
    try {
      const headers = await authHeaders();
      if (!headers) {
        setNeedReauth(true);
        setLoadFailed(true);
        setNotify(null);
        setMsg("เซสชันหมดอายุหรือถูกบล็อกใน LINE — กดปุ่มยืนยันตัวตนอีกครั้ง แล้ว YouTube / ลิงก์ข่าว / เวลาส่ง จะโหลดขึ้นมา (ข้อมูลไม่ได้หาย)");
        return;
      }
      const [ys, fs, nt] = await Promise.all([
        fetch("/api/oauth/google/status", { cache: "no-store", headers }).then((r) => r.json()),
        fetch("/api/feeds", { cache: "no-store", headers }).then((r) => r.json()),
        fetch("/api/notify", { cache: "no-store", headers }).then((r) => r.json()),
      ]);
      if (ys && !ys.error) {
        setYt({ linked: !!ys.linked, email: ys.email || null, name: ys.name || null, channel: ys.channel || null });
      }
      if (Array.isArray(fs)) setFeeds(fs.filter((f: Feed) => f.kind === "rss" || f.kind === "facebook"));
      if (nt && !nt.error && nt.brief && nt.news) setNotify(nt as NotifyCfg);
      setMsg("");
      setNeedReauth(false);
      setLoadFailed(false);
    } catch (e) {
      setMsg("โหลดไม่สำเร็จ: " + (e as Error).message);
      setNeedReauth(true);
      setLoadFailed(true);
      setNotify(null);
    }
  }, [account, authHeaders]);

  useEffect(() => {
    if (!ready) return;
    refresh();
  }, [ready, refresh]);

  useEffect(() => {
    const ytParam = new URLSearchParams(window.location.search).get("yt");
    if (!ytParam) return;
    const map: Record<string, string> = {
      connected: "✅ เชื่อม YouTube สำเร็จแล้ว",
      error: "⚠️ เชื่อม YouTube ไม่สำเร็จ ลองอีกครั้ง",
      no_refresh: "⚠️ Google ไม่ส่ง refresh token — ลองยกเลิกสิทธิ์แอปในบัญชี Google แล้วเชื่อมใหม่",
      no_yt_scope: "⚠️ ยังไม่ได้อนุญาตสิทธิ์ดู YouTube — ตอนกดเชื่อม กรุณาติ๊ก “ดูบัญชี YouTube ของคุณ” ด้วย แล้วเชื่อมใหม่",
      need_google_oauth: "⚠️ ยังไม่ได้ตั้งค่า Google OAuth บนเซิร์ฟเวอร์",
      need_login: "⚠️ กรุณาเข้าสู่ระบบ Microsoft 365 ก่อน",
    };
    setMsg(map[ytParam] || "");
    window.history.replaceState({}, "", "/consents");
    if (ytParam === "connected") refresh();
  }, [refresh]);

  const connectYouTube = async () => {
    const token = await getToken();
    if (!token) {
      setNeedReauth(true);
      await reauth();
      return;
    }
    window.location.href = `/api/oauth/google/start?token=${encodeURIComponent(token)}&back=/consents`;
  };

  const unlinkYouTube = async () => {
    setBusy(true);
    try {
      const headers = await authHeaders();
      if (!headers) throw new Error("need login");
      await fetch("/api/oauth/google/status", { method: "DELETE", headers });
      setConfirmUnlinkYt(false);
      setYt({ linked: false, email: null, name: null, channel: null });
      await refresh();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const startPreview = async (kind: "rss" | "facebook") => {
    const url = (kind === "rss" ? newUrl : fbUrl).trim();
    const label = (kind === "rss" ? newLabel : fbLabel).trim();
    const setErr = kind === "rss" ? setFeedMsg : setFbMsg;
    setErr("");
    if (kind === "rss" && !/^https?:\/\//i.test(url)) {
      setErr("ใส่ลิงก์ RSS ที่ขึ้นต้นด้วย http:// หรือ https:// ครับ");
      return;
    }
    if (kind === "facebook" && !url) {
      setErr("ใส่ลิงก์เพจ Facebook หรือรหัสเพจครับ");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/feeds/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, kind }),
      });
      const data = await res.json();
      if (!data?.ok) {
        setErr(data?.error || "ดูรายการล่วงหน้าไม่ได้");
      } else {
        setPreview({
          kind,
          url,
          label: label || data.source || "",
          source: data.source || url,
          items: data.items || [],
        });
      }
    } catch (e) {
      setErr("ดูรายการล่วงหน้าไม่ได้: " + (e as Error).message);
    }
    setBusy(false);
  };

  const confirmAddFeed = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const headers = await authHeaders();
      if (!headers) throw new Error("กรุณาเข้าสู่ระบบก่อน");
      const res = await fetch("/api/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          kind: preview.kind,
          ref: preview.url,
          label: preview.label,
          notify: true,
          items: preview.items,
        }),
      });
      const data = await res.json();
      if (data?.error) {
        if (preview.kind === "rss") setFeedMsg("เพิ่มไม่สำเร็จ: " + data.error);
        else setFbMsg("เพิ่มไม่สำเร็จ: " + data.error);
      } else {
        const cap = preview.kind === "facebook" ? "src_facebook" : "src_rss";
        await fetch("/api/consents", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ capability: cap, granted: true }),
        });
        if (preview.kind === "rss") {
          setNewUrl("");
          setNewLabel("");
          setFeedMsg(data.lineNotified
            ? "✅ เพิ่มแล้ว และส่งรายการไปที่ LINE แล้ว"
            : "✅ เพิ่มแล้ว (ยังไม่ได้ผูก LINE — แจ้งในแชทไม่ได้)");
        } else {
          setFbUrl("");
          setFbLabel("");
          setFbMsg(data.lineNotified
            ? "✅ เพิ่มเพจแล้ว และส่งรายการไปที่ LINE แล้ว"
            : "✅ เพิ่มเพจแล้ว (ยังไม่ได้ผูก LINE — แจ้งในแชทไม่ได้)");
        }
        setPreview(null);
        await refresh();
      }
    } catch (e) {
      const err = "เพิ่มไม่สำเร็จ: " + (e as Error).message;
      if (preview.kind === "rss") setFeedMsg(err);
      else setFbMsg(err);
    }
    setBusy(false);
  };

  const removeFeed = async (id: number) => {
    setBusy(true);
    try {
      const headers = await authHeaders();
      if (!headers) throw new Error("need login");
      await fetch(`/api/feeds?id=${id}`, { method: "DELETE", headers });
      await refresh();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const saveNotify = async (kind: "brief" | "news", patch: Partial<NotifyKindCfg>) => {
    setNotify((prev) => (prev ? { ...prev, [kind]: { ...prev[kind], ...patch } } : prev));
    try {
      const headers = await authHeaders();
      if (!headers) return;
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ kind, ...patch }),
      });
      const data = await res.json();
      if (data && !data.error && data.brief && data.news) setNotify(data as NotifyCfg);
    } catch { /* keep optimistic value */ }
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
          {upn ? (
            <p className="text-[11px] text-emerald-400/80 mt-2">บัญชี: {upn}</p>
          ) : (
            <button onClick={login}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white">
              <LogIn className="w-4 h-4" /> เข้าสู่ระบบ Microsoft 365
            </button>
          )}
          {msg && <p className="text-xs text-amber-300 mt-2">{msg}</p>}
          {needReauth && (
            <button
              onClick={() => reauth()}
              className="mt-3 w-full inline-flex items-center justify-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white"
            >
              <LogIn className="w-4 h-4" /> ยืนยันตัวตน Microsoft 365 อีกครั้ง
            </button>
          )}
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

          {/* Facebook pages */}
          <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Facebook className="w-4 h-4 text-blue-400" /> Facebook — เพจที่ติดตาม
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Meta ไม่เปิด API ให้ดึง “เพจที่กดติดตาม” อัตโนมัติ — เพิ่มลิงก์เพจที่อยากได้ทีละเพจ ระบบจะดึงโพสต์ล่าสุดมาสรุปให้
            </p>

            {fbFeeds.length === 0 ? (
              <p className="text-xs text-slate-500">ยังไม่มีเพจที่ติดตาม</p>
            ) : (
              <ul className="space-y-2">
                {fbFeeds.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-900/60 border border-slate-800">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-200 truncate">{f.label || f.ref}</div>
                      {f.label && <div className="text-[11px] text-slate-500 truncate">{f.ref}</div>}
                    </div>
                    <button onClick={() => removeFeed(f.id)} disabled={busy}
                      className="shrink-0 p-2 rounded-lg text-rose-300 hover:bg-slate-800 border border-slate-700" aria-label="ลบเพจ">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-2">
              <input value={fbUrl} onChange={(e) => setFbUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") startPreview("facebook"); }}
                placeholder="ลิงก์เพจ เช่น https://www.facebook.com/YourPage"
                className="w-full text-xs px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500" />
              <div className="flex gap-2">
                <input value={fbLabel} onChange={(e) => setFbLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") startPreview("facebook"); }}
                  placeholder="ชื่อย่อ (ไม่ใส่ก็ได้)"
                  className="flex-1 text-xs px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500" />
                <button onClick={() => startPreview("facebook")} disabled={busy || !fbUrl.trim()}
                  className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
                  <Plus className="w-4 h-4" /> ดูรายการ
                </button>
              </div>
              {fbMsg && <p className="text-[11px] text-rose-400">{fbMsg}</p>}
            </div>
          </div>

          {/* custom RSS links */}
          <div className="p-4 rounded-xl bg-slate-800/60 border border-slate-700 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Rss className="w-4 h-4 text-amber-400" /> ลิงก์ข่าว/บล็อก (RSS) ที่ติดตาม
            </div>

            {rssFeeds.length === 0 ? (
              <p className="text-xs text-slate-500">ยังไม่มีลิงก์ที่ติดตาม — เพิ่มลิงก์ RSS ด้านล่างได้เลย</p>
            ) : (
              <ul className="space-y-2">
                {rssFeeds.map((f) => (
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
                onKeyDown={(e) => { if (e.key === "Enter") startPreview("rss"); }}
                placeholder="วางลิงก์ RSS เช่น https://www.blognone.com/atom.xml"
                className="w-full text-xs px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500" />
              <div className="flex gap-2">
                <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") startPreview("rss"); }}
                  placeholder="ชื่อย่อ (ไม่ใส่ก็ได้)"
                  className="flex-1 text-xs px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-sky-500" />
                <button onClick={() => startPreview("rss")} disabled={busy || !newUrl.trim()}
                  className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 disabled:opacity-50">
                  <Plus className="w-4 h-4" /> ดูรายการ
                </button>
              </div>
              {feedMsg && <p className="text-[11px] text-rose-400">{feedMsg}</p>}
              <p className="text-[11px] text-slate-500 leading-relaxed">
                กด “ดูรายการ” ก่อน — ระบบจะแสดงข่าวล่าสุดให้ตรวจ แล้วค่อยยืนยันติดตาม (แจ้งเข้า LINE ด้วยถ้าผูกไว้แล้ว)
              </p>
            </div>
          </div>

          {/* preview confirm modal */}
          {preview && (
            <div className="p-4 rounded-xl bg-sky-500/10 border border-sky-500/30 text-xs text-sky-50/90 leading-relaxed space-y-3">
              <div className="font-semibold text-sky-300 flex items-center gap-1.5">
                {preview.kind === "facebook" ? <Facebook className="w-4 h-4" /> : <Rss className="w-4 h-4" />}
                รายการล่าสุดจาก “{preview.source}” — ตรวจก่อนยืนยันติดตาม
              </div>
              <ol className="list-decimal list-inside space-y-1.5">
                {preview.items.map((it, i) => (
                  <li key={i} className="text-slate-200">
                    <span className="font-medium">{it.title || "(ไม่มีหัวข้อ)"}</span>
                    {it.summary && <div className="text-[11px] text-slate-400 ml-4 mt-0.5 line-clamp-2">{it.summary}</div>}
                  </li>
                ))}
              </ol>
              <p className="text-[11px] text-slate-400">ยืนยันแล้วระบบจะบันทึกแหล่งนี้ และส่งรายการนี้ไปทาง LINE (ถ้าผูกบัญชีไว้)</p>
              <div className="flex gap-2">
                <button onClick={confirmAddFeed} disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 font-semibold px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950">
                  ยืนยันติดตาม
                </button>
                <button onClick={() => setPreview(null)} disabled={busy}
                  className="flex-1 font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">
                  ยกเลิก
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2"><CalendarClock className="w-4 h-4" /> เวลาที่ AI ส่งให้อัตโนมัติ (ทาง LINE)</h2>
          <p className="text-[11px] text-slate-500 leading-relaxed -mt-1">
            ตั้งเวลาและวันที่อยากให้ผู้ช่วยส่ง “สรุปตารางเช้า” และ “สรุปข่าว” เข้ามาใน LINE เอง · นัดใหม่จะแจ้งทันทีเมื่อระบบตรวจพบ · ปิด/เปิดแยกกันได้
          </p>

          {notify ? (
            <>
              <NotifyCard
                icon={<CalendarClock className="w-5 h-5 text-slate-950" />} color="bg-amber-400"
                title="สรุปตารางเช้า (Morning Brief)"
                hint="นัดหมาย/งานของวันนี้ · นัดใหม่แจ้ง LINE แยกต่างหากอัตโนมัติ"
                cfg={notify.brief} disabled={busy}
                onChange={(patch) => saveNotify("brief", patch)}
              />
              <NotifyCard
                icon={<Newspaper className="w-5 h-5 text-slate-950" />} color="bg-sky-400"
                title="สรุปข่าวที่ติดตาม (News Digest)"
                hint="ข่าว RSS + Facebook + คลิป YouTube ที่ติดตาม"
                cfg={notify.news} disabled={busy} showCount
                onChange={(patch) => saveNotify("news", patch)}
              />
              <p className="text-[11px] text-slate-500 leading-relaxed">
                ค่าเริ่มต้น: ตาราง + ข่าว จ–ศ 07:00 (ส่งต่อกันทันที) ·{" "}
                {(notify.news.count ?? 3) === 0
                  ? "ทั้งหมดที่อัปเดตวันนี้"
                  : `${notify.news.count ?? 3} ข่าว/วัน`}{" "}
                · นัดใหม่ตรวจทุก ~15 นาที
              </p>
            </>
          ) : loadFailed || needReauth ? (
            <p className="text-xs text-amber-300/90 leading-relaxed">
              โหลดการตั้งค่าเวลาไม่ได้ — กด “ยืนยันตัวตน Microsoft 365 อีกครั้ง” ด้านบน แล้วข้อมูลจะกลับมา (ไม่ได้ถูกลบ)
            </p>
          ) : account ? (
            <p className="text-xs text-slate-500">กำลังโหลดการตั้งค่า…</p>
          ) : (
            <p className="text-xs text-slate-500">เข้าสู่ระบบ Microsoft 365 เพื่อตั้งเวลาส่ง</p>
          )}
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
