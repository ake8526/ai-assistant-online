"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink, Loader2, LogOut } from "lucide-react";
import { useM365Auth } from "@/components/M365AuthProvider";
import {
  authedGet,
  BlankNote,
  FOLD,
  INK_2,
  N_BLUE,
  N_GREEN,
  N_ORANGE,
  N_PINK,
  N_PURPLE,
  NOTE,
  NOTE_SM,
  PRESS,
} from "@/components/noteStyles";

type Settings = {
  work_start?: string;
  work_end?: string;
  work_location?: string;
  home_location?: string;
  error?: string;
};

type MsStatus = { linked?: boolean; note?: string; error?: string };

function Group({
  title,
  tint,
  tilt,
  children,
}: {
  title: string;
  tint: string;
  tilt: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className={`font-marker text-[14px] ${INK_2} -rotate-[0.7deg]`}>{title}</h3>
      <div className={`${NOTE} ${FOLD} ${tint} ${tilt} px-4 py-1.5`}>{children}</div>
    </section>
  );
}

function Row({ children, last = false }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div
      className={`py-3 flex items-center gap-3 ${last ? "" : "border-b-2 border-dashed border-[#d9d5cc]"}`}
    >
      {children}
    </div>
  );
}

export default function SettingsTab() {
  const { account, logout, getToken, getGraphToken } = useM365Auth();
  const [s, setS] = useState<Settings | null>(null);
  const [ms, setMs] = useState<MsStatus | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    const [settings, status] = await Promise.all([
      authedGet<Settings>("/api/settings", getToken, getGraphToken).catch((e) => ({
        error: (e as Error).message,
      })),
      authedGet<MsStatus>("/api/oauth/microsoft/status", getToken, getGraphToken).catch((e) => ({
        error: (e as Error).message,
      })),
    ]);
    setS(settings);
    setMs(status);
    setBusy(false);
  }, [getToken, getGraphToken]);

  // โหลดข้อมูลจริงตอนเปิดแท็บ — กฎนี้ไล่เข้าไปเห็น setState ใน load() แต่ทุกตัว
  // เกิดหลัง await แล้ว ไม่ได้ set ตรงใน effect body (React ยอมรับ fetch แบบนี้)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const grantCalendar = async () => {
    const token = await getToken();
    if (!token) return;
    window.location.href = `/api/oauth/microsoft/start?token=${encodeURIComponent(token)}&back=/`;
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5 max-w-2xl w-full mx-auto">
      <h2 className="font-marker text-[19px]">การตั้งค่า</h2>

      {busy && <BlankNote>กำลังโหลดการตั้งค่า…</BlankNote>}

      {!busy && (
        <>
          <Group title="บัญชีผู้ใช้ &amp; องค์กร" tint={N_BLUE} tilt="-rotate-[0.6deg]">
            <Row>
              <div className="flex-1 min-w-0">
                <h4 className="text-[14px] font-semibold truncate">{account?.username}</h4>
                <p className={`text-[12px] ${INK_2}`}>{account?.name || "Microsoft 365 · KTIS Group"}</p>
              </div>
              <span
                className={`${NOTE_SM} ${N_GREEN} px-2 py-0.5 font-hand text-[15px] font-bold shrink-0 inline-flex items-center gap-1`}
              >
                <Check className="w-3 h-3" /> เข้าสู่ระบบแล้ว
              </span>
            </Row>
            <Row last>
              <div className="flex-1 min-w-0">
                <h4 className="text-[14px] font-semibold">สิทธิ์อ่านปฏิทิน</h4>
                <p className={`text-[12px] ${INK_2}`}>
                  {ms?.note || "ให้แอปเห็นตารางเท่าที่ Microsoft 365 อนุญาต"}
                </p>
              </div>
              {ms?.linked ? (
                <span
                  className={`${NOTE_SM} ${N_GREEN} px-2 py-0.5 font-hand text-[15px] font-bold shrink-0`}
                >
                  อนุญาตแล้ว
                </span>
              ) : (
                <button
                  onClick={() => void grantCalendar()}
                  className={`${NOTE_SM} ${PRESS} bg-white px-2.5 py-1 text-[12.5px] shrink-0 cursor-pointer`}
                >
                  อนุญาต
                </button>
              )}
            </Row>
          </Group>

          <Group title="เวลาทำงาน &amp; สถานที่" tint={N_PURPLE} tilt="rotate-[0.5deg]">
            <Row>
              <div className="flex-1 min-w-0">
                <h4 className="text-[14px] font-semibold">เวลาทำงาน</h4>
                <p className={`text-[12px] ${INK_2}`}>ใช้คำนวณเวลาว่างและเวลาเตือน</p>
              </div>
              <span className={`${NOTE_SM} bg-white px-2 py-0.5 font-hand text-[16px] font-bold shrink-0`}>
                {s?.work_start || "09:00"} – {s?.work_end || "17:00"}
              </span>
            </Row>
            <Row>
              <div className="flex-1 min-w-0">
                <h4 className="text-[14px] font-semibold">ที่ทำงาน</h4>
                <p className={`text-[12px] ${INK_2} truncate`}>{s?.work_location || "ยังไม่ตั้ง"}</p>
              </div>
            </Row>
            <Row last>
              <div className="flex-1 min-w-0">
                <h4 className="text-[14px] font-semibold">ที่พัก</h4>
                <p className={`text-[12px] ${INK_2} truncate`}>{s?.home_location || "ยังไม่ตั้ง"}</p>
              </div>
            </Row>
          </Group>

          <Group title="หน้าอื่นในระบบ" tint={N_ORANGE} tilt="-rotate-[0.4deg]">
            <Row>
              <Link href="/settings" className="flex-1 min-w-0 flex items-center gap-2">
                <span className="flex-1 min-w-0">
                  <h4 className="text-[14px] font-semibold">ตั้งค่าแบบเต็ม</h4>
                  <p className={`text-[12px] ${INK_2}`}>เวลาทำงาน สถานที่ ข่าว การแจ้งเตือน</p>
                </span>
                <ExternalLink className="w-4 h-4 shrink-0" />
              </Link>
            </Row>
            <Row last>
              <Link href="/ai-office" className="flex-1 min-w-0 flex items-center gap-2">
                <span className="flex-1 min-w-0">
                  <h4 className="text-[14px] font-semibold">AI Office</h4>
                  <p className={`text-[12px] ${INK_2}`}>หน้ารวมงานประชุมและสรุป</p>
                </span>
                <ExternalLink className="w-4 h-4 shrink-0" />
              </Link>
            </Row>
          </Group>

          <button
            onClick={() => void logout()}
            className={`${NOTE} ${PRESS} ${N_PINK} w-full py-3 flex items-center justify-center gap-2 text-[14px] font-semibold cursor-pointer`}
          >
            <LogOut className="w-4 h-4" /> ออกจากระบบ
          </button>

          {(s?.error || ms?.error) && (
            <p className={`text-[12px] ${INK_2}`}>
              โหลดบางส่วนไม่สำเร็จ: {s?.error || ms?.error}
            </p>
          )}
        </>
      )}

      {busy && <Loader2 className="w-4 h-4 animate-spin mx-auto" />}
    </div>
  );
}
