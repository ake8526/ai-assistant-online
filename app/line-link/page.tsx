"use client";

import React, { useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import Link from "next/link";
import { UserCheck, LogIn, CheckCircle2, AlertTriangle, Settings } from "lucide-react";

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

type Status = "init" | "ready" | "linking" | "linked" | "error";

// Reject a hanging promise after `ms` so a slow SDK/network step can't freeze the
// page forever on "กำลังเชื่อมต่อ…".
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} ใช้เวลานานเกินไป`)), ms)),
  ]);
}

function LineLinkContent() {
  const { account, login } = useM365Auth();
  const [status, setStatus] = useState<Status>("init");
  const [msg, setMsg] = useState("กำลังเริ่มต้น…");
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  // upn this LINE account is currently linked to (from the server), if any
  const [linkedUpn, setLinkedUpn] = useState<string | null>(null);

  useEffect(() => {
    document.title = "ผูกบัญชี Microsoft 365 กับ LINE";
    (async () => {
      if (!LIFF_ID) { setStatus("error"); setMsg("ยังไม่ได้ตั้งค่า NEXT_PUBLIC_LIFF_ID ที่เซิร์ฟเวอร์"); return; }
      try {
        setMsg("กำลังโหลด LINE SDK…");
        await withTimeout(loadLiffSdk(), 10000, "โหลด LINE SDK");
        setMsg("กำลังเริ่ม LIFF…");
        await withTimeout(window.liff!.init({ liffId: LIFF_ID }), 10000, "เริ่ม LIFF");
        if (!window.liff!.isLoggedIn()) {
          setMsg("กำลังพาไปเข้าสู่ระบบ LINE…");
          window.liff!.login();      // redirects to LINE, then returns here
          return;
        }
        setMsg("กำลังดึงข้อมูลบัญชี LINE…");
        const p = await withTimeout(window.liff!.getProfile(), 10000, "ดึงข้อมูล LINE");
        setProfile(p);
        // Already linked? (short timeout so a cold API call can't hang the UI)
        setMsg("กำลังตรวจสอบการเชื่อมต่อ…");
        try {
          const ctl = new AbortController();
          const to = setTimeout(() => ctl.abort(), 6000);
          const res = await fetch(`/api/line/status?line_user_id=${encodeURIComponent(p.userId)}`, { signal: ctl.signal, cache: "no-store" });
          clearTimeout(to);
          const data = await res.json();
          if (data.linked) {
            setLinkedUpn(data.upn || null);
            setStatus("linked");
            setMsg(`เชื่อมต่อแล้ว${data.upn ? ` — ระบบจะส่งข้อความหา ${data.upn} ทาง LINE นี้` : ""}`);
            return;
          }
        } catch { /* เช็คสถานะไม่ได้/ช้า → ปล่อยให้ผูกบัญชีต่อ */ }
        // Not linked yet — always ask first (show the button), never auto-link,
        // even when opened inside the LINE app.
        setStatus("ready");
        setMsg("พร้อมผูกบัญชีแล้ว — กดปุ่มด้านล่างเพื่อยืนยันการผูก");
      } catch (e) {
        setStatus("error");
        setMsg("เชื่อมต่อ LINE ไม่สำเร็จ: " + (e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upn = account?.username || DEFAULT_UPN;

  const doLink = async (lineUserId: string, displayName: string) => {
    setStatus("linking"); setMsg("กำลังผูกบัญชี…");
    try {
      const res = await fetch(`/api/line/link?upn=${encodeURIComponent(upn)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_user_id: lineUserId, display_name: displayName }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setLinkedUpn(upn);
      setStatus("linked");
      setMsg(`เชื่อมสำเร็จ! ระบบจะส่งข้อความหา ${upn} ทาง LINE นี้`);
    } catch (e) {
      setStatus("error"); setMsg("ผูกบัญชีไม่สำเร็จ: " + (e as Error).message);
    }
  };

  const handleLink = () => {
    if (!profile?.userId) { setMsg("ยังไม่ได้ LINE userId — ลองเปิดหน้านี้ในแอป LINE"); return; }
    doLink(profile.userId, profile.displayName || "");
  };

  const linkedName = linkedUpn || account?.username || DEFAULT_UPN;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 font-sans">
      <div className="max-w-md w-full p-8 rounded-3xl bg-slate-900/80 border border-slate-800 text-center shadow-2xl">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 bg-gradient-to-tr from-emerald-500 to-teal-400">
          {status === "linked" ? <CheckCircle2 className="w-8 h-8 text-slate-950" />
            : <UserCheck className="w-8 h-8 text-slate-950" />}
        </div>
        <h1 className="text-xl font-bold mb-2">🔗 ผูกบัญชี Microsoft 365 กับ LINE</h1>
        <p className="text-xs text-slate-400 mb-4 leading-relaxed">
          เชื่อมแล้วรับสรุปประชุม งานที่ได้รับมอบหมาย และแจ้งเตือน ทาง LINE โดยตรง
        </p>

        <div className="p-3 rounded-xl bg-slate-800/70 border border-slate-700 mb-4 text-left text-xs">
          <div>บัญชี M365: <b>{linkedName}</b></div>
          <div className="mt-1 text-slate-400">LINE: {profile ? (profile.displayName || profile.userId) : "…"}</div>
        </div>

        {/* สถานะ: เชื่อมต่อแล้ว */}
        {status === "linked" && (
          <>
            <div className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl font-semibold text-sm bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 mb-3">
              <CheckCircle2 className="w-4 h-4" /> เชื่อมต่อแล้ว
            </div>
            <Link
              href="/account"
              className="w-full flex items-center justify-center gap-2 p-3 rounded-xl font-semibold text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            >
              <Settings className="w-4 h-4" /> จัดการบัญชี / ยกเลิก
            </Link>
          </>
        )}

        {/* สถานะ: ยังไม่เชื่อม / กำลังทำ / error */}
        {(status === "ready" || status === "init" || status === "linking" || status === "error") && (
          <>
            {!account && status !== "linking" && (
              <button onClick={login} className="w-full flex items-center justify-center gap-2 p-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm mb-3">
                <LogIn className="w-4 h-4" /> เข้าสู่ระบบ Microsoft 365 (ถ้าต้องการระบุตัวตนเอง)
              </button>
            )}
            <button
              onClick={status === "error" ? () => window.location.reload() : handleLink}
              disabled={status === "linking" || status === "init"}
              className={`w-full flex items-center justify-center gap-2 p-3.5 rounded-xl font-semibold text-sm ${
                status === "error" ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                : status === "init" ? "bg-slate-800 text-slate-400 border border-slate-700"
                : "bg-emerald-500 hover:bg-emerald-400 text-slate-950"
              }`}
            >
              {status === "error" ? <><AlertTriangle className="w-4 h-4" /> ลองอีกครั้ง</>
                : status === "linking" ? "กำลังผูก…"
                : status === "init" ? "กำลังเตรียม…"
                : "กดผูกบัญชีกับ LINE"}
            </button>
          </>
        )}

        {msg && (
          <p className={`text-xs mt-4 ${status === "error" ? "text-rose-400" : status === "linked" ? "text-emerald-400" : "text-slate-400"}`}>{msg}</p>
        )}
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
