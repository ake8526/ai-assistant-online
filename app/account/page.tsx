"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import {
  ArrowLeft, CheckCircle2, XCircle, LogIn, Unlink, AlertTriangle,
  Mail, MessageCircle, Youtube, Facebook, Link2,
} from "lucide-react";

const DEFAULT_UPN = process.env.NEXT_PUBLIC_DEFAULT_UPN || "weerasak.pi@ktisgroup.com";

type LineState = { linked: boolean; display_name: string | null; upn: string | null };
type Caps = { src_youtube: boolean; src_facebook: boolean };

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

function Badge({ ok, on = "เชื่อมต่อแล้ว", off = "ยังไม่ได้เชื่อม" }: { ok: boolean; on?: string; off?: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400"><CheckCircle2 className="w-4 h-4" /> {on}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500"><XCircle className="w-4 h-4" /> {off}</span>
  );
}

function AccountContent() {
  const { account, login, logout } = useM365Auth();
  const upn = account?.username || DEFAULT_UPN;

  const [line, setLine] = useState<LineState | null>(null);
  const [caps, setCaps] = useState<Caps>({ src_youtube: false, src_facebook: false });
  const [msg, setMsg] = useState("กำลังโหลด…");
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [confirmUnlinkM365, setConfirmUnlinkM365] = useState(false);
  const [m365Unlinked, setM365Unlinked] = useState(false);

  // ถือว่าเชื่อมต่อ 365 อยู่ ถ้ามี session MSAL หรือระบบรู้จักบัญชีนี้อยู่แล้ว (มี upn จากการผูก LINE)
  const m365Connected = !m365Unlinked && (!!account || !!line?.upn);

  const refresh = useCallback(async () => {
    try {
      const [ls, cs] = await Promise.all([
        fetch(`/api/line/status?upn=${encodeURIComponent(upn)}`).then((r) => r.json()),
        fetch(`/api/consents?upn=${encodeURIComponent(upn)}`).then((r) => r.json()),
      ]);
      setLine({ linked: !!ls.linked, display_name: ls.display_name || null, upn: ls.upn || null });
      if (cs && !cs.error) setCaps({ src_youtube: !!cs.src_youtube, src_facebook: !!cs.src_facebook });
      setMsg("");
    } catch (e) {
      setMsg("โหลดไม่สำเร็จ: " + (e as Error).message);
    }
  }, [upn]);

  useEffect(() => { refresh(); }, [refresh]);

  const unlinkLine = async () => {
    setBusy(true);
    try {
      await fetch(`/api/line/link?upn=${encodeURIComponent(upn)}`, { method: "DELETE" });
      setConfirmUnlink(false);
      await refresh();
    } catch { /* ignore */ }
    setBusy(false);
  };

  // ยกเลิก 365 = ออกจากระบบ 365 + ยกเลิกการผูก LINE ด้วย
  const unlinkM365 = async () => {
    setBusy(true);
    try {
      if (line?.linked) {
        await fetch(`/api/line/link?upn=${encodeURIComponent(upn)}`, { method: "DELETE" });
      }
      if (account) logout();
      setM365Unlinked(true);
      setConfirmUnlinkM365(false);
      await refresh();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const setConsent = async (capability: keyof Caps, granted: boolean) => {
    setBusy(true);
    setCaps((p) => ({ ...p, [capability]: granted }));
    try {
      const data = await fetch(`/api/consents?upn=${encodeURIComponent(upn)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability, granted }),
      }).then((r) => r.json());
      if (data && !data.error) setCaps({ src_youtube: !!data.src_youtube, src_facebook: !!data.src_facebook });
    } catch { /* keep optimistic */ }
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-2xl mx-auto space-y-5">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
          <ArrowLeft className="w-4 h-4" /> หน้าหลัก
        </Link>

        <header className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 text-center">
          <h1 className="text-xl font-bold">👤 บัญชีของฉัน</h1>
          <p className="text-xs text-slate-400 mt-1">ดูว่าเชื่อมบัญชีอะไรไว้ อนุญาตติดตามอะไรบ้าง และยกเลิกได้จากที่นี่</p>
          {msg && <p className="text-xs text-rose-400 mt-2">{msg}</p>}
        </header>

        {/* ---- connected accounts ---- */}
        <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2"><Link2 className="w-4 h-4" /> บัญชีที่เชื่อมต่อ</h2>

          <Row icon={<Mail className="w-5 h-5 text-slate-950" />} color="bg-blue-400"
               title="Microsoft 365" subtitle={upn}>
            {m365Connected ? (
              <button onClick={() => setConfirmUnlinkM365(true)} disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700">
                <Unlink className="w-4 h-4" /> ยกเลิก
              </button>
            ) : (
              <button onClick={async () => { await login(); setM365Unlinked(false); }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white">
                <LogIn className="w-4 h-4" /> เข้าสู่ระบบ
              </button>
            )}
          </Row>

          {confirmUnlinkM365 && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-100/90 leading-relaxed space-y-3">
              <div className="font-semibold text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> ยกเลิกการเชื่อมต่อ Microsoft 365?</div>
              <ul className="list-disc list-inside space-y-1">
                <li>จะออกจากระบบ Microsoft 365 และ<b>ใช้งานสรุปประชุม อีเมล ปฏิทิน และงานที่ได้รับมอบหมายไม่ได้</b></li>
                <li><b>การผูก LINE จะถูกยกเลิกด้วย</b> — ไม่ได้รับการแจ้งเตือนและสรุปข่าว (digest) ทาง LINE อีก</li>
                <li>ข้อมูลงาน/การตั้งค่าติดตามข่าว <b>ยังอยู่เหมือนเดิม</b> (ลบเฉพาะการเชื่อมต่อ)</li>
                <li>เข้าสู่ระบบและผูกใหม่ได้ทุกเมื่อ</li>
              </ul>
              <div className="flex gap-2">
                <button onClick={unlinkM365} disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 font-semibold px-3 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-white">
                  <Unlink className="w-4 h-4" /> ยืนยันยกเลิก
                </button>
                <button onClick={() => setConfirmUnlinkM365(false)} disabled={busy}
                  className="flex-1 font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">
                  ไม่ยกเลิก
                </button>
              </div>
            </div>
          )}

          <Row icon={<MessageCircle className="w-5 h-5 text-slate-950" />} color="bg-emerald-400"
               title="LINE" subtitle={line?.linked ? (line.display_name || "เชื่อมกับ LINE นี้") : "ยังไม่ได้ผูกกับ LINE"}>
            {line?.linked ? (
              <button onClick={() => setConfirmUnlink(true)} disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700">
                <Unlink className="w-4 h-4" /> ยกเลิก
              </button>
            ) : (
              <Link href="/line-link" className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950">
                ผูกบัญชี
              </Link>
            )}
          </Row>

          {line?.linked && <Badge ok on="สถานะ: เชื่อมต่อแล้ว" />}

          {confirmUnlink && (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-100/90 leading-relaxed space-y-3">
              <div className="font-semibold text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> ยกเลิกการผูก LINE?</div>
              <ul className="list-disc list-inside space-y-1">
                <li>จะ<b>ไม่ได้รับ</b>สรุปประชุม งานที่ได้รับมอบหมาย และการแจ้งเตือน ทาง LINE อีก</li>
                <li>จะไม่ได้รับสรุปข่าวที่ติดตาม (digest) ทาง LINE</li>
                <li>ข้อมูลงาน/การตั้งค่าติดตามข่าว <b>ยังอยู่เหมือนเดิม</b> (ลบเฉพาะการเชื่อม LINE)</li>
                <li>ผูกใหม่ได้ทุกเมื่อ</li>
              </ul>
              <div className="flex gap-2">
                <button onClick={unlinkLine} disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 font-semibold px-3 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-white">
                  <Unlink className="w-4 h-4" /> ยืนยันยกเลิก
                </button>
                <button onClick={() => setConfirmUnlink(false)} disabled={busy}
                  className="flex-1 font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700">
                  ไม่ยกเลิก
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ---- follow permissions ---- */}
        <section className="p-5 rounded-3xl bg-slate-900/80 border border-slate-800 space-y-3">
          <h2 className="text-sm font-bold text-slate-200">🔔 การอนุญาตติดตามข่าว</h2>

          <Row icon={<Youtube className="w-5 h-5 text-slate-950" />} color="bg-red-500"
               title="YouTube" subtitle={caps.src_youtube ? "อนุญาตให้ดึงช่องที่ subscribe" : "ยังไม่อนุญาต"}>
            {caps.src_youtube ? (
              <button onClick={() => setConsent("src_youtube", false)} disabled={busy}
                className="text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700">
                ยกเลิก
              </button>
            ) : (
              <button onClick={() => setConsent("src_youtube", true)} disabled={busy}
                className="text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950">
                อนุญาต
              </button>
            )}
          </Row>

          <Row icon={<Facebook className="w-5 h-5 text-slate-950" />} color="bg-blue-500"
               title="Facebook" subtitle="ยังดึงเพจที่ติดตามอัตโนมัติไม่ได้ (ข้อจำกัด Facebook API)">
            <span className="text-xs text-slate-600">ไม่พร้อมใช้</span>
          </Row>

          <p className="text-[11px] text-slate-500 leading-relaxed pt-1">
            จัดการแหล่งข่าว/เชื่อมบัญชี YouTube และดูสรุปข่าว ได้ที่หน้า{" "}
            <Link href="/consents" className="text-sky-400 underline">ติดตามข่าว / ฟีด</Link>
          </p>
        </section>
      </div>
    </div>
  );
}

export default function AccountPage() {
  return (
    <M365AuthProvider>
      <AccountContent />
    </M365AuthProvider>
  );
}
