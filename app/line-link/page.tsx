"use client";

import React, { useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { UserCheck, LogIn, CheckCircle2, AlertTriangle } from "lucide-react";

// LIFF is loaded from the CDN at runtime (no npm dep needed).
type LiffProfile = { userId: string; displayName?: string };
declare global {
  interface Window {
    liff?: {
      init: (c: { liffId: string }) => Promise<void>;
      isLoggedIn: () => boolean;
      isInClient: () => boolean;
      login: () => void;
      getProfile: () => Promise<LiffProfile>;
      closeWindow?: () => void;
    };
  }
}

const LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID || "";
// pilot fallback so linking works even when M365 login isn't available in the LINE webview
const DEFAULT_UPN = process.env.NEXT_PUBLIC_DEFAULT_UPN || "weerasak.pi@ktisgroup.com";

function loadLiffSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.liff) return resolve();
    const s = document.createElement("script");
    s.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("โหลด LIFF SDK ไม่สำเร็จ"));
    document.head.appendChild(s);
  });
}

function LineLinkContent() {
  const { account, login } = useM365Auth();
  const [status, setStatus] = useState<"init" | "ready" | "linking" | "linked" | "error">("init");
  const [msg, setMsg] = useState("กำลังเชื่อมต่อ LINE…");
  const [profile, setProfile] = useState<LiffProfile | null>(null);

  useEffect(() => {
    (async () => {
      if (!LIFF_ID) { setStatus("error"); setMsg("ยังไม่ได้ตั้งค่า NEXT_PUBLIC_LIFF_ID ที่เซิร์ฟเวอร์"); return; }
      try {
        await loadLiffSdk();
        await window.liff!.init({ liffId: LIFF_ID });
        if (!window.liff!.isLoggedIn()) { window.liff!.login(); return; }
        const p = await window.liff!.getProfile();
        setProfile(p);
        setStatus("ready");
        setMsg("พร้อมผูกบัญชีแล้ว");
      } catch (e) {
        setStatus("error");
        setMsg("เริ่ม LIFF ไม่สำเร็จ: " + (e as Error).message);
      }
    })();
  }, []);

  const upn = account?.username || DEFAULT_UPN;

  const handleLink = async () => {
    if (!profile?.userId) { setMsg("ยังไม่ได้ LINE userId — ลองเปิดหน้านี้ในแอป LINE"); return; }
    setStatus("linking"); setMsg("กำลังบันทึกการเชื่อมบัญชี…");
    try {
      const res = await fetch(`/api/line/link?upn=${encodeURIComponent(upn)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_user_id: profile.userId, display_name: profile.displayName || "" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus("linked");
      setMsg(`เชื่อมสำเร็จ! ระบบจะส่งข้อความหา ${upn} ทาง LINE นี้`);
    } catch (e) {
      setStatus("error"); setMsg("บันทึกไม่สำเร็จ: " + (e as Error).message);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 font-sans">
      <div className="max-w-md w-full p-8 rounded-3xl bg-slate-900/80 border border-slate-800 text-center shadow-2xl">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-6">
          <UserCheck className="w-8 h-8 text-slate-950" />
        </div>
        <h1 className="text-xl font-bold mb-2">🔗 ผูกบัญชี Microsoft 365 กับ LINE</h1>
        <p className="text-xs text-slate-400 mb-4 leading-relaxed">
          เชื่อมแล้วรับสรุปประชุม งานที่ได้รับมอบหมาย และแจ้งเตือน ทาง LINE โดยตรง
        </p>

        <div className="p-3 rounded-xl bg-slate-800/70 border border-slate-700 mb-4 text-left text-xs">
          <div>บัญชี M365: <b>{account?.username || `${DEFAULT_UPN} (pilot)`}</b></div>
          <div className="mt-1 text-slate-400">LINE: {profile ? (profile.displayName || profile.userId) : "…"}</div>
        </div>

        {!account && (
          <button onClick={login} className="w-full flex items-center justify-center gap-2 p-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm mb-3">
            <LogIn className="w-4 h-4" /> เข้าสู่ระบบ Microsoft 365 (ถ้าต้องการระบุตัวตนเอง)
          </button>
        )}

        <button
          onClick={handleLink}
          disabled={status === "linking" || status === "linked" || status === "init"}
          className={`w-full flex items-center justify-center gap-2 p-3.5 rounded-xl font-semibold text-sm ${
            status === "linked" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
            : status === "error" ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
            : "bg-emerald-500 hover:bg-emerald-400 text-slate-950"
          }`}
        >
          {status === "linked" ? <><CheckCircle2 className="w-4 h-4" /> ผูกบัญชีสำเร็จ</>
            : status === "error" ? <><AlertTriangle className="w-4 h-4" /> ลองอีกครั้ง</>
            : status === "linking" ? "กำลังผูก…"
            : status === "init" ? "กำลังเตรียม…"
            : "กดผูกบัญชีกับ LINE"}
        </button>

        <p className={`text-xs mt-4 ${status === "error" ? "text-rose-400" : status === "linked" ? "text-emerald-400" : "text-slate-400"}`}>{msg}</p>
      </div>
    </div>
  );
}

export default function LineLinkPage() {
  return (
    <M365AuthProvider>
      <LineLinkContent />
    </M365AuthProvider>
  );
}
