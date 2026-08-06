"use client";

import React, { Suspense, useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import Link from "next/link";
import { UserCheck, LogIn, CheckCircle2, AlertTriangle, Settings } from "lucide-react";
import SetupTestPanel from "@/components/SetupTestPanel";
import SetupBriefPreviewPanel from "@/components/SetupBriefPreviewPanel";

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

/** Inside LINE app → close LIFF after a short success beat. */
function closeLiffSoon(delayMs = 1200) {
  setTimeout(() => {
    try {
      if (window.liff?.isInClient?.() && typeof window.liff.closeWindow === "function") {
        window.liff.closeWindow();
      }
    } catch {
      /* ignore */
    }
  }, delayMs);
}

function LineLinkRouter() {
  const [view, setView] = useState<string | null>(null);

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v === "setup-test") {
      setView(v);
      return;
    }
    if (v === "setup-brief") {
      setView(v);
      return;
    }
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) {
      window.location.replace(next);
      return;
    }
    setView("link");
  }, []);

  if (view === "setup-test") return <SetupTestPanel />;
  if (view === "setup-brief") return <SetupBriefPreviewPanel />;
  if (view === "link") return <LineLinkContent />;
  return (
    <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center text-sm">
      กำลังโหลด…
    </div>
  );
}

function LineLinkContent() {
  const { account, login, getToken } = useM365Auth();
  const [status, setStatus] = useState<Status>("init");
  const [msg, setMsg] = useState("กำลังเริ่มต้น…");
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  // upn this LINE account is currently linked to (from the server), if any
  const [linkedUpn, setLinkedUpn] = useState<string | null>(null);
  const [inLiffClient, setInLiffClient] = useState(false);

  useEffect(() => {
    document.title = "ผูกบัญชี Microsoft 365 กับ LINE";
    (async () => {
      if (!LIFF_ID) { setStatus("error"); setMsg("ยังไม่ได้ตั้งค่า NEXT_PUBLIC_LIFF_ID ที่เซิร์ฟเวอร์"); return; }
      try {
        setMsg("กำลังโหลด LINE SDK…");
        await withTimeout(loadLiffSdk(), 10000, "โหลด LINE SDK");
        setMsg("กำลังเริ่ม LIFF…");
        await withTimeout(window.liff!.init({ liffId: LIFF_ID }), 10000, "เริ่ม LIFF");
        setInLiffClient(!!window.liff!.isInClient());
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
            const inLine = !!window.liff!.isInClient();
            setInLiffClient(inLine);
            setMsg(
              inLine
                ? `เชื่อมต่อแล้ว — กำลังปิดหน้าต่าง…`
                : `เชื่อมต่อแล้ว${data.upn ? ` — ระบบจะส่งข้อความหา ${data.upn} ทาง LINE นี้` : ""}`
            );
            if (inLine) closeLiffSoon(1200);
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

  const upn = account?.username || "";

  const doLink = async (lineUserId: string, displayName: string) => {
    if (!upn) { setStatus("error"); setMsg("กรุณาเข้าสู่ระบบ Microsoft 365 ก่อนผูกบัญชี"); return; }
    setStatus("linking"); setMsg("กำลังผูกบัญชี…");
    try {
      const token = await getToken();
      if (!token) throw new Error("เข้าสู่ระบบ Microsoft 365 ไม่สำเร็จ — ลองใหม่อีกครั้ง");
      const res = await fetch("/api/line/link", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ line_user_id: lineUserId, display_name: displayName }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setLinkedUpn(data.upn || upn);
      setStatus("linked");
      const inLine = !!window.liff?.isInClient?.();
      setInLiffClient(inLine);
      setMsg(
        inLine
          ? `เชื่อมสำเร็จ! กำลังปิดหน้าต่าง…`
          : `เชื่อมสำเร็จ! ระบบจะส่งข้อความหา ${data.upn || upn} ทาง LINE นี้`
      );
      if (inLine) closeLiffSoon(1200);
    } catch (e) {
      setStatus("error"); setMsg("ผูกบัญชีไม่สำเร็จ: " + (e as Error).message);
    }
  };

  const handleLink = () => {
    if (!account) { login(); return; }
    if (!profile?.userId) { setMsg("ยังไม่ได้ LINE userId — ลองเปิดหน้านี้ในแอป LINE"); return; }
    doLink(profile.userId, profile.displayName || "");
  };

  const linkedName = linkedUpn || account?.username || "(ยังไม่ได้เข้าสู่ระบบ M365)";

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
            {inLiffClient ? (
              <p className="text-xs text-slate-500 mb-3">หน้าต่างจะปิดอัตโนมัติ — หรือกด ✕ มุมบนขวา</p>
            ) : (
              <Link
                href="/account"
                className="w-full flex items-center justify-center gap-2 p-3 rounded-xl font-semibold text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
              >
                <Settings className="w-4 h-4" /> จัดการบัญชี / ยกเลิก
              </Link>
            )}
          </>
        )}

        {/* สถานะ: ยังไม่เชื่อม / กำลังทำ / error */}
        {(status === "ready" || status === "init" || status === "linking" || status === "error") && (
          <>
            {!account && status !== "linking" && (
              <button onClick={login} className="w-full flex items-center justify-center gap-2 p-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm mb-3">
                <LogIn className="w-4 h-4" /> เข้าสู่ระบบ Microsoft 365 ก่อน
              </button>
            )}
            <button
              onClick={status === "error" ? () => window.location.reload() : handleLink}
              disabled={status === "linking" || status === "init" || !account}
              className={`w-full flex items-center justify-center gap-2 p-3.5 rounded-xl font-semibold text-sm ${
                status === "error" ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                : status === "init" || !account ? "bg-slate-800 text-slate-400 border border-slate-700"
                : "bg-emerald-500 hover:bg-emerald-400 text-slate-950"
              }`}
            >
              {status === "error" ? <><AlertTriangle className="w-4 h-4" /> ลองอีกครั้ง</>
                : status === "linking" ? "กำลังผูก…"
                : status === "init" ? "กำลังเตรียม…"
                : !account ? "เข้าสู่ระบบ M365 ก่อนผูก LINE"
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
      <Suspense
        fallback={
          <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center text-sm">
            กำลังโหลด…
          </div>
        }
      >
        <LineLinkRouter />
      </Suspense>
    </M365AuthProvider>
  );
}
