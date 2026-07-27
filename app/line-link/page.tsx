"use client";

import React, { useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { ShieldCheck, UserCheck, LogIn, ArrowRight, CheckCircle2 } from "lucide-react";

function LineLinkContent() {
  const { account, login, isAuthenticated } = useM365Auth();
  const [linked, setLinked] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLinkLine = async () => {
    if (!account) {
      await login();
      return;
    }
    setLoading(true);
    setTimeout(() => {
      setLinked(true);
      setLoading(false);
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 font-sans">
      <div className="max-w-md w-full p-8 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl text-center shadow-2xl">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-6 shadow-lg shadow-emerald-500/20">
          <UserCheck className="w-8 h-8 text-slate-950" />
        </div>

        <h1 className="text-xl font-bold mb-2">🔗 ผูกบัญชี Microsoft 365 กับ LINE</h1>
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
          onClick={handleLinkLine}
          disabled={loading || linked}
          className={`w-full flex items-center justify-center gap-2 p-3.5 rounded-xl font-semibold text-sm transition shadow-lg ${
            linked
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
              : "bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20"
          }`}
        >
          {linked ? (
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

        <p className="text-[10px] text-slate-500 mt-6">
          ระบบรักษาความปลอดภัยสูง ปฏิบัติตามมาตรฐาน PDPA ไม่เปิดเผยข้อมูลส่วนบุคคล
        </p>
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
