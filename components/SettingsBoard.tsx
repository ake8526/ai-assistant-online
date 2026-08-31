"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BellRing,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  HelpCircle,
  Loader2,
  LogOut,
  MonitorSmartphone,
  Plug,
  UserRound,
  X,
} from "lucide-react";
import { useM365Auth } from "@/components/M365AuthProvider";
import {
  authedGet,
  BOARD,
  FOLD,
  INK_2,
  INK_3,
  N_BLUE,
  N_GREEN,
  N_ORANGE,
  N_PINK,
  N_PURPLE,
  N_YELLOW,
  NOTE,
  NOTE_SM,
  PRESS,
} from "@/components/noteStyles";

export type Settings = {
  work_start?: string;
  work_end?: string;
  work_location?: string;
  home_location?: string;
  error?: string;
};
export type MsStatus = { linked?: boolean; note?: string; error?: string };
export type SettingsData = { settings: Settings | null; ms: MsStatus | null };

const AWAKE_KEY = "ktisx_keep_awake";

/** สะพานที่แอป Android ฉีดเข้ามา — มีเมธอดเดียวคือกันจอดับ */
type ScreenBridge = { setKeepAwake?: (on: boolean) => void };
function appBridge(): ScreenBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as { KtisxApp?: ScreenBridge }).KtisxApp;
  return b && typeof b.setKeepAwake === "function" ? b : null;
}

/**
 * กันจอดับ — สองทางเรียงตามความน่าเชื่อถือ
 *
 * 1. ในแอป: บอก Android ให้ถือธง FLAG_KEEP_SCREEN_ON เอง ระบบไม่แย่งคืน
 * 2. บนเบราว์เซอร์: Screen Wake Lock API ซึ่งระบบยึดคืนเงียบ ๆ ได้ และหลุดทุกครั้ง
 *    ที่หน้าถูกซ่อน จึงต้องขอใหม่เมื่อกลับมา
 */
function useKeepAwake() {
  const [on, setOn] = useState(false);
  const [supported, setSupported] = useState(true);
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(!!appBridge() || (typeof navigator !== "undefined" && "wakeLock" in navigator));
    try {
      setOn(localStorage.getItem(AWAKE_KEY) === "1");
    } catch {
      /* โหมดส่วนตัวอ่านไม่ได้ ก็ถือว่าปิด */
    }
  }, []);

  useEffect(() => {
    const bridge = appBridge();
    if (bridge) {
      bridge.setKeepAwake!(on);
      return () => bridge.setKeepAwake!(false);
    }
    if (!on) {
      void lockRef.current?.release().catch(() => {});
      lockRef.current = null;
      return;
    }
    let dead = false;
    const acquire = async () => {
      if (dead || document.visibilityState !== "visible") return;
      if (!("wakeLock" in navigator)) return;
      try {
        lockRef.current = await navigator.wakeLock.request("screen");
      } catch {
        /* ระบบปฏิเสธ — ขอใหม่รอบหน้า */
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", acquire);
      void lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [on]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      localStorage.setItem(AWAKE_KEY, next ? "1" : "0");
    } catch {
      /* จำไม่ได้ก็ยังใช้ได้ในรอบนี้ */
    }
  };

  return { on, supported, toggle };
}

/** ตัวเลือกเวลาทำงาน ทุกครึ่งชั่วโมง 06:00–21:00 */
const CLOCK = Array.from({ length: 31 }, (_, i) => {
  const m = 6 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});

type CatId = "acct" | "hours" | "notify" | "screen" | "link" | "help";

function Sw({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`${NOTE_SM} ${PRESS} shrink-0 w-[52px] h-[28px] relative disabled:opacity-40 ${
        on ? N_GREEN : "bg-white"
      } cursor-pointer`}
    >
      <span
        className={`absolute top-[2px] w-[20px] h-[20px] rounded-full border-2 border-[#232122] bg-white transition-[left] ${
          on ? "left-[26px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

function Row({ children, last = false }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`py-3 flex items-center gap-3 ${last ? "" : "border-b-2 border-dashed border-[#d9d5cc]"}`}>
      {children}
    </div>
  );
}

/**
 * ตั้งค่าเป็นบอร์ดการ์ดหมวดหมู่
 *
 * การ์ดแต่ละใบสรุป "ค่าที่ตั้งไว้จริง" ไม่ใช่แค่จำนวนเมนูย่อย เปิดหน้ามาจึงรู้
 * สถานะทันทีโดยไม่ต้องกดเข้าไปดูทีละหมวด แตะการ์ดแล้วรายละเอียดเลื่อนขึ้นมาปรับ
 */
export default function SettingsBoard({
  data,
  onChange,
}: {
  data: SettingsData;
  onChange: (next: SettingsData) => void;
}) {
  const { account, logout, getToken, getGraphToken } = useM365Auth();
  const [open, setOpen] = useState<CatId | null>(null);
  const [saving, setSaving] = useState("");
  const awake = useKeepAwake();

  const s = data.settings;
  const ms = data.ms;

  const load = useCallback(async () => {
    const [settings, status] = await Promise.all([
      authedGet<Settings>("/api/settings", getToken, getGraphToken).catch((e) => ({
        error: (e as Error).message,
      })),
      authedGet<MsStatus>("/api/oauth/microsoft/status", getToken, getGraphToken).catch((e) => ({
        error: (e as Error).message,
      })),
    ]);
    onChange({ settings, ms: status });
  }, [getToken, getGraphToken, onChange]);

  useEffect(() => {
    if (data.settings || data.ms) return;
    void load();
  }, [data.settings, data.ms, load]);

  const saveHours = async (field: "work_start" | "work_end", value: string) => {
    const before = s;
    onChange({ ...data, settings: { ...(s || {}), [field]: value } });
    setSaving(field);
    try {
      const token = await getToken();
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [field]: value }),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      onChange({ ...data, settings: before });
    }
    setSaving("");
  };

  const grantCalendar = async () => {
    const token = await getToken();
    if (!token) return;
    window.location.href = `/api/oauth/microsoft/start?token=${encodeURIComponent(token)}&back=/`;
  };

  const dash = "—";
  const hours = s ? `${s.work_start || "09:00"} – ${s.work_end || "17:00"}` : dash;

  const CATS: {
    id: CatId;
    tint: string;
    tilt: string;
    Icon: React.ComponentType<{ className?: string }>;
    title: string;
    kbtn: string;
    lines: string[];
  }[] = [
    {
      id: "acct",
      tint: N_BLUE,
      tilt: "-rotate-[0.7deg]",
      Icon: UserRound,
      title: "บัญชี & สิทธิ์",
      kbtn: "Microsoft 365",
      lines: [
        account?.username || dash,
        account?.name || "KTIS Group",
        `สิทธิ์อ่านปฏิทิน: ${ms === null ? dash : ms.linked ? "อนุญาตแล้ว" : "ยังไม่อนุญาต"}`,
      ],
    },
    {
      id: "hours",
      tint: N_YELLOW,
      tilt: "rotate-[0.6deg]",
      Icon: Clock,
      title: "เวลาทำงาน & สถานที่",
      kbtn: "3 รายการ",
      lines: [
        `ทำงาน ${hours}`,
        `ที่ทำงาน: ${s === null ? dash : s.work_location || "ยังไม่ตั้ง"}`,
        `ที่พัก: ${s === null ? dash : s.home_location || "ยังไม่ตั้ง"}`,
      ],
    },
    {
      id: "notify",
      tint: N_GREEN,
      tilt: "-rotate-[0.5deg]",
      Icon: BellRing,
      title: "การแจ้งเตือน",
      kbtn: "ทาง LINE",
      lines: ["เตือนก่อนประชุม", "สรุปงานเช้าทุกวันทำการ", "ช่องทาง: LINE"],
    },
    {
      id: "screen",
      tint: N_PINK,
      tilt: "rotate-[0.5deg]",
      Icon: MonitorSmartphone,
      title: "หน้าจอ",
      kbtn: awake.supported ? "รองรับ" : "ไม่รองรับ",
      lines: [
        `ไม่ให้พักจอ: ${awake.on ? "เปิด" : "ปิด"}`,
        appBridge() ? "ใช้ธงของ Android (แน่นอนกว่า)" : "ใช้ Wake Lock ของเบราว์เซอร์",
        "ธีม: สว่าง",
      ],
    },
    {
      id: "link",
      tint: N_PURPLE,
      tilt: "-rotate-[0.4deg]",
      Icon: Plug,
      title: "เชื่อมต่อ",
      kbtn: "LINE & M365",
      lines: [
        `Microsoft 365: ${ms === null ? dash : ms.linked ? "เชื่อมแล้ว" : "ยังไม่อนุญาต"}`,
        "LINE: สั่งงานผ่านแชทได้",
        "หน้าอื่น: ตั้งค่าเต็ม · AI Office",
      ],
    },
    {
      id: "help",
      tint: N_ORANGE,
      tilt: "rotate-[0.4deg]",
      Icon: HelpCircle,
      title: "ช่วยเหลือ & ระบบ",
      kbtn: "v3.0",
      lines: ["คู่มือคำสั่งทั้งหมด", "Graph · Supabase · LINE", "KTIS X — ฉบับโน้ตแปะกระดาน"],
    },
  ];

  const cat = CATS.find((c) => c.id === open);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto relative">
      <div className="flex items-center gap-2.5">
        <h2 className="font-marker text-[19px] flex-1">ตั้งค่า</h2>
        <span className={`${NOTE_SM} bg-white px-2.5 py-0.5 text-[12px] shrink-0`}>6 หมวด</span>
      </div>

      {/* กรอบเส้นประ บอกว่าการ์ดข้างในคือของที่แปะอยู่บนบอร์ด */}
      <div className="border-2 border-dashed border-[#d9d5cc] rounded-[16px] p-3 space-y-3">
        <p className={`font-marker text-[12.5px] ${INK_2} px-0.5`}>แตะการ์ดเพื่อดูและปรับค่า</p>
        <div className="grid grid-cols-2 gap-3">
          {CATS.map(({ id, tint, tilt, Icon, title, kbtn, lines }) => (
            <button
              key={id}
              onClick={() => setOpen(id)}
              className={`${NOTE} ${tint} ${tilt} ${PRESS} px-3 pt-3 pb-2.5 flex flex-col gap-1.5 text-left cursor-pointer`}
            >
              <h3 className="text-[13.5px] font-bold leading-tight flex items-center gap-1.5">
                <Icon className="w-4 h-4 shrink-0" />
                {title}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {lines.map((l, i) => (
                  <li key={i} className={`text-[11px] ${INK_2} flex gap-1.5`}>
                    <span className={INK_3}>▪</span>
                    <span className="truncate">{l}</span>
                  </li>
                ))}
              </ul>
              <span className="mt-auto pt-2 border-t-2 border-dashed border-[#232122]/20 flex items-center justify-between gap-1.5">
                <span className={`${NOTE_SM} bg-white px-1.5 py-0 text-[10.5px] font-semibold shadow-none`}>
                  {kbtn}
                </span>
                <span className="text-[11.5px] flex items-center gap-0.5">
                  เปิด <ChevronDown className="w-3 h-3" />
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <p className={`font-hand text-[15px] ${INK_3} text-center`}>KTIS X · v3.0</p>

      {/* ---------- แผ่นรายละเอียดของหมวด ---------- */}
      {cat && (
        <>
          <div
            className="fixed inset-0 z-40 bg-[#232122]/35"
            onClick={() => setOpen(null)}
            aria-hidden="true"
          />
          <div
            className={`fixed left-0 right-0 bottom-0 z-40 ${BOARD} border-t-[2.5px] border-[#232122] rounded-t-[22px] max-h-[80%] flex flex-col`}
            role="dialog"
            aria-label={cat.title}
          >
            <span className="w-[46px] h-[5px] rounded-full bg-[#d9d5cc] mx-auto mt-2.5 mb-1 shrink-0" />
            <div className="px-4 pb-2.5 flex items-center gap-2.5 shrink-0">
              <h3 className="font-marker text-[16px] flex-1">{cat.title}</h3>
              <button
                onClick={() => setOpen(null)}
                aria-label="ปิด"
                className={`${NOTE_SM} ${PRESS} bg-white grid place-items-center w-9 h-9 cursor-pointer`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-5">
              <div className={`${NOTE} ${FOLD} ${cat.tint} px-4 py-1.5`}>
                {cat.id === "acct" && (
                  <>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold truncate">{account?.username}</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>{account?.name || "Microsoft 365 · KTIS Group"}</p>
                      </div>
                      <span
                        className={`${NOTE_SM} ${N_GREEN} px-2 py-0.5 font-hand text-[15px] font-bold shrink-0 inline-flex items-center gap-1`}
                      >
                        <Check className="w-3 h-3" /> เข้าสู่ระบบแล้ว
                      </span>
                    </Row>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">สิทธิ์อ่านปฏิทิน</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>
                          {ms?.note || "ให้แอปเห็นตารางเท่าที่ Microsoft 365 อนุญาต"}
                        </p>
                      </div>
                      {ms === null ? (
                        <span className={`${INK_3} font-hand text-[15px]`}>{dash}</span>
                      ) : ms.linked ? (
                        <span className={`${NOTE_SM} ${N_GREEN} px-2 py-0.5 font-hand text-[15px] font-bold shrink-0`}>
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
                    <Row last>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">ออกจากระบบ</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>ต้องล็อกอินใหม่ครั้งถัดไป</p>
                      </div>
                      <button
                        onClick={() => void logout()}
                        className={`${NOTE_SM} ${PRESS} ${N_PINK} px-2.5 py-1 text-[12.5px] shrink-0 inline-flex items-center gap-1.5 cursor-pointer`}
                      >
                        <LogOut className="w-3.5 h-3.5" /> ออก
                      </button>
                    </Row>
                  </>
                )}

                {cat.id === "hours" && (
                  <>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">เวลาทำงาน</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>ใช้คำนวณเวลาว่างและเวลาเตือนทั้งระบบ</p>
                      </div>
                      {s === null ? (
                        <span className={`${INK_3} font-hand text-[15px]`}>{dash}</span>
                      ) : (
                        <span className="flex items-center gap-1.5 shrink-0">
                          <select
                            aria-label="เวลาเริ่มงาน"
                            value={s.work_start || "09:00"}
                            onChange={(e) => void saveHours("work_start", e.target.value)}
                            className={`${NOTE_SM} bg-white px-1.5 py-0.5 font-hand text-[16px] font-bold cursor-pointer`}
                          >
                            {CLOCK.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <span className="font-hand text-[16px]">–</span>
                          <select
                            aria-label="เวลาเลิกงาน"
                            value={s.work_end || "17:00"}
                            onChange={(e) => void saveHours("work_end", e.target.value)}
                            className={`${NOTE_SM} bg-white px-1.5 py-0.5 font-hand text-[16px] font-bold cursor-pointer`}
                          >
                            {CLOCK.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        </span>
                      )}
                    </Row>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">ที่ทำงาน</h4>
                        <p className={`text-[11.5px] ${INK_2} truncate`}>
                          {s === null ? dash : s.work_location || "ยังไม่ตั้ง"}
                        </p>
                      </div>
                    </Row>
                    <Row last>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">ที่พัก</h4>
                        <p className={`text-[11.5px] ${INK_2} truncate`}>
                          {s === null ? dash : s.home_location || "ยังไม่ตั้ง"}
                        </p>
                      </div>
                    </Row>
                  </>
                )}

                {cat.id === "notify" && (
                  <>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">เตือนก่อนประชุม · สรุปงานเช้า</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>
                          ตั้งเวลาและเปิด-ปิดได้ที่หน้าตั้งค่าเต็ม ซึ่งคุมของทั้งระบบรวมข่าวด้วย
                        </p>
                      </div>
                    </Row>
                    <Row last>
                      <Link href="/settings" className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="flex-1 min-w-0">
                          <h4 className="text-[13.5px] font-semibold">เปิดหน้าตั้งค่าเต็ม</h4>
                          <p className={`text-[11.5px] ${INK_2}`}>เวลาทำงาน สถานที่ ข่าว การแจ้งเตือน</p>
                        </span>
                        <ExternalLink className="w-4 h-4 shrink-0" />
                      </Link>
                    </Row>
                  </>
                )}

                {cat.id === "screen" && (
                  <>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">ไม่ให้พักจอ</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>
                          {awake.supported
                            ? "จอค้างไว้ระหว่างเปิดแอป เหมาะกับตอนวางดูตารางบนโต๊ะ"
                            : "เครื่องนี้ไม่รองรับ — ตั้งเวลาพักจอที่การตั้งค่าเครื่องแทน"}
                        </p>
                      </div>
                      <Sw on={awake.on} onClick={awake.toggle} label="ไม่ให้พักจอ" disabled={!awake.supported} />
                    </Row>
                    <Row last>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">วิธีที่ใช้กันจอดับ</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>
                          {appBridge()
                            ? "ธง FLAG_KEEP_SCREEN_ON ของ Android — ระบบไม่แย่งคืน"
                            : "Screen Wake Lock ของเบราว์เซอร์ — ระบบอาจยึดคืนเมื่อแบตต่ำ"}
                        </p>
                      </div>
                    </Row>
                  </>
                )}

                {cat.id === "link" && (
                  <>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">Microsoft 365</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>ปฏิทิน ห้องประชุม และการจอง</p>
                      </div>
                      {ms?.linked ? (
                        <span className={`${NOTE_SM} ${N_GREEN} px-2 py-0.5 font-hand text-[15px] font-bold shrink-0`}>
                          เชื่อมแล้ว
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
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">LINE</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>สั่งงานผ่านแชท LINE ได้เรื่องเดียวกัน</p>
                      </div>
                      <Link
                        href="/line-link"
                        className={`${NOTE_SM} ${PRESS} bg-white px-2.5 py-1 text-[12.5px] shrink-0`}
                      >
                        เชื่อม
                      </Link>
                    </Row>
                    <Row last>
                      <Link href="/ai-office" className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="flex-1 min-w-0">
                          <h4 className="text-[13.5px] font-semibold">AI Office</h4>
                          <p className={`text-[11.5px] ${INK_2}`}>หน้ารวมงานประชุมและสรุป</p>
                        </span>
                        <ExternalLink className="w-4 h-4 shrink-0" />
                      </Link>
                    </Row>
                  </>
                )}

                {cat.id === "help" && (
                  <>
                    <Row>
                      <Link href="/help" className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="flex-1 min-w-0">
                          <h4 className="text-[13.5px] font-semibold">คู่มือคำสั่ง</h4>
                          <p className={`text-[11.5px] ${INK_2}`}>ตัวอย่างประโยคที่สั่งได้ทั้งหมด</p>
                        </span>
                        <ExternalLink className="w-4 h-4 shrink-0" />
                      </Link>
                    </Row>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">สถานะระบบ</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>Microsoft Graph · Supabase · LINE</p>
                      </div>
                      <span className={`${NOTE_SM} ${N_GREEN} px-2 py-0.5 font-hand text-[15px] font-bold shrink-0`}>
                        ปกติ
                      </span>
                    </Row>
                    <Row last>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">เวอร์ชัน</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>KTIS X — ฉบับโน้ตแปะกระดาน</p>
                      </div>
                      <span className={`${NOTE_SM} bg-white px-2 py-0.5 font-hand text-[15px] font-bold shrink-0`}>
                        v3.0
                      </span>
                    </Row>
                  </>
                )}
              </div>

              {(s?.error || ms?.error) && (
                <p className={`text-[11.5px] ${INK_2} mt-3`}>โหลดบางส่วนไม่สำเร็จ: {s?.error || ms?.error}</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
