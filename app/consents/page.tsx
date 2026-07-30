"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { ShieldCheck, Youtube, Facebook, CheckCircle2, ArrowLeft } from "lucide-react";

const DEFAULT_UPN = process.env.NEXT_PUBLIC_DEFAULT_UPN || "weerasak.pi@ktisgroup.com";
type Caps = { src_youtube: boolean; src_facebook: boolean };

// only sources that AUTO-follow what the user already follows (no manual URL entry)
const CAP_ROWS = [
  { key: "src_youtube", label: "YouTube — ดึงช่องที่คุณ subscribe อัตโนมัติ", icon: Youtube, color: "text-red-400" },
  { key: "src_facebook", label: "Facebook Page Feeds (ยังดึงอัตโนมัติไม่ได้)", icon: Facebook, color: "text-blue-400" },
] as const;

function ConsentsContent() {
  const { account } = useM365Auth();
  const upn = account?.username || DEFAULT_UPN;

  const [consents, setConsents] = useState<Caps>({ src_youtube: false, src_facebook: false });
  const [msg, setMsg] = useState("กำลังโหลด…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const c = await fetch(`/api/consents?upn=${encodeURIComponent(upn)}`).then((r) => r.json());
      if (c && !c.error) setConsents({ src_youtube: !!c.src_youtube, src_facebook: !!c.src_facebook });
      setMsg(`บัญชี: ${upn}`);
    } catch (e) {
      setMsg("โหลดไม่สำเร็จ: " + (e as Error).message);
    }
  }, [upn]);

  useEffect(() => { refresh(); }, [refresh]);

  const setConsent = async (capability: keyof Caps, granted: boolean) => {
    setBusy(true);
    setConsents((p) => ({ ...p, [capability]: granted }));
    try {
      const res = await fetch(`/api/consents?upn=${encodeURIComponent(upn)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability, granted }),
      });
      const data = await res.json();
      if (data && !data.error) setConsents({ src_youtube: !!data.src_youtube, src_facebook: !!data.src_facebook });
    } catch { /* keep optimistic */ }
    setBusy(false);
  };

  const connectYouTube = () => {
    // /api/oauth/google/start redirects to Google consent (or 400 JSON if not configured)
    window.location.href = `/api/oauth/google/start?upn=${encodeURIComponent(upn)}`;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-2xl mx-auto space-y-6">
        <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
          <ArrowLeft className="w-4 h-4" /> ตั้งค่า
        </Link>

        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 text-center shadow-2xl">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-4">
            <ShieldCheck className="w-7 h-7 text-slate-950" />
          </div>
          <h1 className="text-xl font-bold mb-1">📰 ติดตามข่าว (แบบไปตามมาให้อัตโนมัติ)</h1>
          <p className="text-xs text-slate-400">{msg}</p>
        </div>

        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-4">
          <h2 className="text-sm font-bold text-slate-200">อนุญาตแหล่งที่ระบบจะดึงให้ (กดเพื่อเปิด/ปิด — บันทึกทันที)</h2>
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

          <div className="pt-4 border-t border-slate-800 space-y-3">
            <button onClick={connectYouTube} disabled={busy}
              className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-xs shadow-lg shadow-red-600/20 disabled:opacity-60">
              <Youtube className="w-4 h-4" /> เชื่อมบัญชี YouTube (Google Login)
            </button>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              💡 <b>YouTube</b> คือแหล่งเดียวที่ระบบ &quot;ไปตามมาให้เอง&quot; ได้จริง — ล็อกอิน Google ครั้งเดียว
              ระบบจะดึงช่องที่คุณ subscribe มาสรุปให้ ไม่ต้องกรอกเอง (ต้องตั้งค่า Google OAuth ที่เซิร์ฟเวอร์ก่อน)<br />
              <b>Facebook</b> ยังดึง &quot;เพจที่คุณติดตาม&quot; อัตโนมัติไม่ได้ (ข้อจำกัดของ Facebook API)
            </p>
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
