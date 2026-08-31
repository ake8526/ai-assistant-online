"use client";

import React, { useCallback, useEffect, useState } from "react";
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
import type { KeepAwake } from "@/components/useKeepAwake";
import type { BuildInfo } from "@/components/useFreshBuild";
import { THEME_LABEL, THEME_MODES, type Theme, type ThemeMode } from "@/components/useTheme";

export type Settings = {
  work_start?: string;
  work_end?: string;
  work_location?: string;
  home_location?: string;
  error?: string;
};
export type MsStatus = { linked?: boolean; note?: string; error?: string };

/** ตารางเวลาแจ้งเตือนจาก /api/notify — brief = สรุปงานเช้า, news = ข่าว */
export type NotifyKindCfg = { enabled: boolean; time: string; days: number[]; count?: number };
export type NotifyCfg = { brief: NotifyKindCfg; news: NotifyKindCfg; error?: string };

export type HealthPart = { key: string; name: string; level: "ok" | "warn" | "down"; note: string };
export type Health = { level: "ok" | "warn" | "down"; label: string; parts: HealthPart[]; error?: string };

export type SettingsData = {
  settings: Settings | null;
  ms: MsStatus | null;
  notify: NotifyCfg | null;
  health: Health | null;
};

/** ตัวเลือกเวลาทำงาน ทุกครึ่งชั่วโมง 06:00–21:00 */
const CLOCK = Array.from({ length: 31 }, (_, i) => {
  const m = 6 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});

/** เวลาแจ้งเตือนละเอียดกว่า ทุก 15 นาที 05:00–22:00 */
const NOTIFY_CLOCK = Array.from({ length: 69 }, (_, i) => {
  const m = 5 * 60 + i * 15;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});

/**
 * ตัวเลือกเวลา บวกเวลาที่ใช้อยู่จริงเข้าไปถ้ายังไม่มีในรายการ
 *
 * สรุปเช้าถูกเลื่อนอัตโนมัติไปหลังข่าวหนึ่งนาที (lib/notify.ts) เวลาที่ใช้จริงจึง
 * เป็น 07:01 ซึ่งไม่ลงล็อกทุก 15 นาที ถ้าไม่ใส่เข้าไปด้วย <select> จะเด้งไปโชว์
 * ตัวเลือกแรก (05:00) เหมือนตั้งไว้อย่างนั้น
 */
function timeChoices(current: string): string[] {
  if (!current || NOTIFY_CLOCK.includes(current)) return NOTIFY_CLOCK;
  return [...NOTIFY_CLOCK, current].sort();
}

const DAY_LABEL = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** "จ–ศ" อ่านง่ายกว่า "1,2,3,4,5" */
function daysLabel(days: number[]): string {
  const set = Array.from(new Set(days)).sort((a, b) => a - b);
  if (!set.length) return "ไม่มีวันไหนเลย";
  if (set.length === 7) return "ทุกวัน";
  if (set.join(",") === "1,2,3,4,5") return "จ–ศ";
  if (set.join(",") === "0,6") return "เสาร์–อาทิตย์";
  return set.map((d) => DAY_LABEL[d]).join(" ");
}

type CatId = "acct" | "hours" | "notify" | "screen" | "link" | "help";

const SURFACE = "bg-[var(--nb-surface)]";
const SELECT = `${"border-2 border-[var(--nb-ink)] rounded-[11px] shadow-[2px_2px_0_var(--nb-ink)]"} ${SURFACE} px-1.5 py-0.5 font-hand text-[16px] font-bold cursor-pointer`;

function Sw({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`${NOTE_SM} ${PRESS} shrink-0 w-[52px] h-[28px] relative disabled:opacity-40 ${
        on ? N_GREEN : SURFACE
      } cursor-pointer`}
    >
      <span
        className={`absolute top-[2px] w-[20px] h-[20px] rounded-full border-2 border-[var(--nb-ink)] ${SURFACE} transition-[left] ${
          on ? "left-[26px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

function Row({ children, last = false }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`py-3 flex items-center gap-3 ${last ? "" : "border-b-2 border-dashed border-[var(--nb-dash)]"}`}>
      {children}
    </div>
  );
}

/** ปุ่มวันในสัปดาห์ — กดแล้วบันทึกทันที */
function DayPicker({ days, onToggle }: { days: number[]; onToggle: (d: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {DAY_LABEL.map((d, i) => (
        <button
          key={i}
          onClick={() => onToggle(i)}
          aria-pressed={days.includes(i)}
          className={`${NOTE_SM} ${PRESS} w-8 py-0.5 text-[11.5px] cursor-pointer ${
            days.includes(i) ? N_GREEN : `${SURFACE} ${INK_3} shadow-none`
          }`}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

/** ช่องกรอกสถานที่ — บันทึกเมื่อออกจากช่องหรือกด Enter ไม่ยิงทุกตัวอักษร */
function PlaceRow({
  title,
  hint,
  value,
  saving,
  onSave,
  last,
}: {
  title: string;
  hint: string;
  value: string;
  saving: boolean;
  onSave: (v: string) => void;
  last?: boolean;
}) {
  // ตัวที่เรียกใช้ผูก key ไว้กับค่าที่บันทึกแล้ว ช่องนี้จึงถูกสร้างใหม่เมื่อค่าจาก
  // เซิร์ฟเวอร์เปลี่ยน (โหลดเสร็จ หรือบันทึกล้มเหลวแล้วย้อนคืน) โดยไม่ต้องมี effect
  // มาไล่ตามค่า — และไม่แย่งตัวอักษรตอนผู้ใช้กำลังพิมพ์ เพราะค่านั้นยังไม่เปลี่ยน
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onSave(v);
    else setDraft(value);
  };

  return (
    <Row last={last}>
      <div className="flex-1 min-w-0">
        <h4 className="text-[13.5px] font-semibold">{title}</h4>
        <p className={`text-[11.5px] ${INK_2}`}>{hint}</p>
      </div>
      <span className="flex items-center gap-1.5 shrink-0">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="ยังไม่ตั้ง"
          aria-label={title}
          className={`${NOTE_SM} ${SURFACE} w-[130px] px-2 py-1 text-[12.5px]`}
        />
        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      </span>
    </Row>
  );
}

/**
 * ตั้งค่าเป็นบอร์ดการ์ดหมวดหมู่
 *
 * การ์ดแต่ละใบสรุป "ค่าที่ตั้งไว้จริง" ไม่ใช่แค่จำนวนเมนูย่อย เปิดหน้ามาจึงรู้
 * สถานะทันทีโดยไม่ต้องกดเข้าไปดูทีละหมวด แตะการ์ดแล้วรายละเอียดเลื่อนขึ้นมาปรับ
 *
 * ค่าทั้งหมดถูกดึงไว้ตอนฉากโหลดแล้วส่งเข้ามาทาง props หน้านี้จึงไม่มีรอบโหลด
 * ของตัวเอง ส่วนสวิตช์กันจอดับกับธีมอยู่ที่เปลือกแอป เพราะต้องมีผลทุกแท็บ
 * ไม่ใช่แค่ตอนเปิดหน้านี้ค้างไว้
 */
export default function SettingsBoard({
  data,
  onChange,
  keepAwake,
  theme,
  build,
}: {
  data: SettingsData;
  onChange: (next: SettingsData) => void;
  keepAwake: KeepAwake;
  theme: Theme;
  build: BuildInfo;
}) {
  const { account, logout, getToken, getGraphToken } = useM365Auth();
  const [open, setOpen] = useState<CatId | null>(null);
  const [saving, setSaving] = useState("");

  const s = data.settings;
  const ms = data.ms;
  const nf = data.notify;
  const health = data.health;

  const load = useCallback(async () => {
    const [settings, status] = await Promise.all([
      authedGet<Settings>("/api/settings", getToken, getGraphToken).catch((e) => ({
        error: (e as Error).message,
      })),
      authedGet<MsStatus>("/api/oauth/microsoft/status", getToken, getGraphToken).catch((e) => ({
        error: (e as Error).message,
      })),
    ]);
    onChange({ ...data, settings, ms: status });
  }, [getToken, getGraphToken, onChange, data]);

  useEffect(() => {
    if (data.settings || data.ms) return;
    void load();
  }, [data.settings, data.ms, load]);

  /** POST /api/settings — แสดงค่าใหม่ทันที ถ้าเซิร์ฟเวอร์ปฏิเสธค่อยย้อนคืน */
  const saveSetting = async (
    field: "work_start" | "work_end" | "work_location" | "home_location",
    value: string
  ) => {
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
      onChange({ ...data, settings: { ...(before || {}), error: "บันทึกไม่สำเร็จ ลองอีกครั้งครับ" } });
    }
    setSaving("");
  };

  /** POST /api/notify — คืนตารางชุดเต็มกลับมา จึงเอาของจริงมาแทนค่าที่เดาไว้ได้ */
  const saveNotify = async (kind: "brief" | "news", patch: Partial<NotifyKindCfg>) => {
    if (!nf) return;
    const before = nf;
    onChange({ ...data, notify: { ...nf, [kind]: { ...nf[kind], ...patch } } });
    setSaving(`nf_${kind}`);
    try {
      const token = await getToken();
      const r = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, ...patch }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const fresh = (await r.json()) as NotifyCfg;
      if (fresh.brief && fresh.news) onChange({ ...data, notify: fresh });
    } catch {
      onChange({ ...data, notify: { ...before, error: "บันทึกเวลาแจ้งเตือนไม่สำเร็จ" } });
    }
    setSaving("");
  };

  const toggleDay = (kind: "brief" | "news", day: number) => {
    if (!nf) return;
    const cur = nf[kind].days;
    const next = cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day].sort((a, b) => a - b);
    void saveNotify(kind, { days: next });
  };

  const grantCalendar = async () => {
    const token = await getToken();
    if (!token) return;
    window.location.href = `/api/oauth/microsoft/start?token=${encodeURIComponent(token)}&back=/`;
  };

  const dash = "—";
  const hours = s ? `${s.work_start || "09:00"} – ${s.work_end || "17:00"}` : dash;
  const healthTint =
    health === null ? SURFACE : health.level === "ok" ? N_GREEN : health.level === "warn" ? N_YELLOW : N_PINK;

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
      lines:
        nf === null
          ? [dash, dash, "ส่งทาง LINE ที่ผูกไว้"]
          : [
              `สรุปงานเช้า: ${nf.brief.enabled ? `${nf.brief.time} · ${daysLabel(nf.brief.days)}` : "ปิด"}`,
              `ข่าว: ${nf.news.enabled ? `${nf.news.time} · ${daysLabel(nf.news.days)}` : "ปิด"}`,
              "ส่งทาง LINE ที่ผูกไว้",
            ],
    },
    {
      id: "screen",
      tint: N_PINK,
      tilt: "rotate-[0.5deg]",
      Icon: MonitorSmartphone,
      title: "หน้าจอ",
      kbtn: keepAwake.supported ? "รองรับ" : "ไม่รองรับ",
      lines: [
        `ไม่ให้พักจอ: ${keepAwake.on ? "เปิด" : "ปิด"}`,
        `ธีม: ${THEME_LABEL[theme.mode]}${theme.mode === "auto" ? ` (ตอนนี้${theme.dark ? "มืด" : "สว่าง"})` : ""}`,
        "สองค่านี้จำไว้ในเครื่องนี้",
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
      lines: [
        "คู่มือคำสั่งทั้งหมด",
        `สถานะระบบ: ${health === null ? "กำลังตรวจ…" : health.label}`,
        `โค้ด: ${build.mine || "—"}${build.stale ? " (มีรุ่นใหม่)" : ""}`,
      ],
    },
  ];

  const cat = CATS.find((c) => c.id === open);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto relative">
      <div className="flex items-center gap-2.5">
        <h2 className="font-marker text-[19px] flex-1">ตั้งค่า</h2>
        <span className={`${NOTE_SM} ${SURFACE} px-2.5 py-0.5 text-[12px] shrink-0`}>6 หมวด</span>
      </div>

      {/* กรอบเส้นประ บอกว่าการ์ดข้างในคือของที่แปะอยู่บนบอร์ด */}
      <div className="border-2 border-dashed border-[var(--nb-dash)] rounded-[16px] p-3 space-y-3">
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
              <span className="mt-auto pt-2 border-t-2 border-dashed border-[var(--nb-ink)]/20 flex items-center justify-between gap-1.5">
                <span className={`${NOTE_SM} ${SURFACE} px-1.5 py-0 text-[10.5px] font-semibold shadow-none`}>
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
          <div className="fixed inset-0 z-40 bg-[var(--nb-scrim)]" onClick={() => setOpen(null)} aria-hidden="true" />
          <div
            className={`fixed left-0 right-0 bottom-0 z-40 ${BOARD} border-t-[2.5px] border-[var(--nb-ink)] rounded-t-[22px] max-h-[80%] flex flex-col`}
            role="dialog"
            aria-label={cat.title}
          >
            <span className="w-[46px] h-[5px] rounded-full bg-[var(--nb-dash)] mx-auto mt-2.5 mb-1 shrink-0" />
            <div className="px-4 pb-2.5 flex items-center gap-2.5 shrink-0">
              <h3 className="font-marker text-[16px] flex-1">{cat.title}</h3>
              <button
                onClick={() => setOpen(null)}
                aria-label="ปิด"
                className={`${NOTE_SM} ${PRESS} ${SURFACE} grid place-items-center w-9 h-9 cursor-pointer`}
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
                          className={`${NOTE_SM} ${PRESS} ${SURFACE} px-2.5 py-1 text-[12.5px] shrink-0 cursor-pointer`}
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
                            onChange={(e) => void saveSetting("work_start", e.target.value)}
                            className={SELECT}
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
                            onChange={(e) => void saveSetting("work_end", e.target.value)}
                            className={SELECT}
                          >
                            {CLOCK.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          {(saving === "work_start" || saving === "work_end") && (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          )}
                        </span>
                      )}
                    </Row>
                    <PlaceRow
                      key={`work-${s?.work_location || ""}`}
                      title="ที่ทำงาน"
                      hint="ใช้ตอบเรื่องการเดินทางและเวลาที่ต้องออก"
                      value={s?.work_location || ""}
                      saving={saving === "work_location"}
                      onSave={(v) => void saveSetting("work_location", v)}
                    />
                    <PlaceRow
                      key={`home-${s?.home_location || ""}`}
                      title="ที่พัก"
                      hint="พิมพ์ชื่อสถานที่หรือที่อยู่ก็ได้"
                      value={s?.home_location || ""}
                      saving={saving === "home_location"}
                      onSave={(v) => void saveSetting("home_location", v)}
                      last
                    />
                  </>
                )}

                {cat.id === "notify" && (
                  <>
                    {nf === null ? (
                      <Row last>
                        <p className={`text-[12.5px] ${INK_2} flex items-center gap-2`}>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังอ่านตารางเวลาแจ้งเตือน…
                        </p>
                      </Row>
                    ) : (
                      <>
                        <Row>
                          <div className="flex-1 min-w-0">
                            <h4 className="text-[13.5px] font-semibold">สรุปงานเช้า</h4>
                            <p className={`text-[11.5px] ${INK_2}`}>
                              นัดของวันนั้นกับงานที่ต้องติดตาม ส่งเข้า LINE ตามเวลาที่ตั้ง
                            </p>
                          </div>
                          <Sw
                            on={nf.brief.enabled}
                            onClick={() => void saveNotify("brief", { enabled: !nf.brief.enabled })}
                            label="สรุปงานเช้า"
                          />
                        </Row>
                        {nf.brief.enabled && (
                          <Row>
                            <div className="flex-1 min-w-0">
                              <h4 className="text-[13.5px] font-semibold">เวลาและวันของสรุปเช้า</h4>
                              {nf.news.enabled && nf.brief.time !== nf.news.time && (
                                <p className={`text-[11px] ${INK_3}`}>
                                  ตั้งเวลาเดียวกับข่าวได้ ระบบเลื่อนสรุปไปหลังข่าว 1 นาทีให้เอง
                                </p>
                              )}
                              <DayPicker days={nf.brief.days} onToggle={(d) => toggleDay("brief", d)} />
                            </div>
                            <span className="flex items-center gap-1.5 shrink-0">
                              <select
                                aria-label="เวลาส่งสรุปเช้า"
                                value={nf.brief.time}
                                onChange={(e) => void saveNotify("brief", { time: e.target.value })}
                                className={SELECT}
                              >
                                {timeChoices(nf.brief.time).map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                              {saving === "nf_brief" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            </span>
                          </Row>
                        )}
                        <Row>
                          <div className="flex-1 min-w-0">
                            <h4 className="text-[13.5px] font-semibold">ข่าวประจำวัน</h4>
                            <p className={`text-[11.5px] ${INK_2}`}>
                              {nf.news.enabled
                                ? `วันละ ${
                                    nf.news.count === 0 ? "ทุกข่าวของวันนั้น" : `${nf.news.count ?? 3} ข่าว`
                                  } ตามหัวข้อที่เลือกไว้`
                                : "ปิดอยู่ — เปิดแล้วเลือกเวลาและจำนวนได้"}
                            </p>
                          </div>
                          <Sw
                            on={nf.news.enabled}
                            onClick={() => void saveNotify("news", { enabled: !nf.news.enabled })}
                            label="ข่าวประจำวัน"
                          />
                        </Row>
                        {nf.news.enabled && (
                          <Row>
                            <div className="flex-1 min-w-0">
                              <h4 className="text-[13.5px] font-semibold">เวลาและจำนวนข่าว</h4>
                              <DayPicker days={nf.news.days} onToggle={(d) => toggleDay("news", d)} />
                            </div>
                            <span className="flex flex-col items-end gap-1 shrink-0">
                              <select
                                aria-label="เวลาส่งข่าว"
                                value={nf.news.time}
                                onChange={(e) => void saveNotify("news", { time: e.target.value })}
                                className={SELECT}
                              >
                                {timeChoices(nf.news.time).map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                              </select>
                              <select
                                aria-label="จำนวนข่าวต่อวัน"
                                value={String(nf.news.count ?? 3)}
                                onChange={(e) => void saveNotify("news", { count: Number(e.target.value) })}
                                className={`${NOTE_SM} ${SURFACE} px-1.5 py-0.5 text-[12px] cursor-pointer`}
                              >
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                                  <option key={n} value={n}>
                                    {n} ข่าว
                                  </option>
                                ))}
                                <option value={0}>ทุกข่าว</option>
                              </select>
                              {saving === "nf_news" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            </span>
                          </Row>
                        )}
                        <Row last>
                          <Link href="/line-link" className="flex-1 min-w-0 flex items-center gap-2">
                            <span className="flex-1 min-w-0">
                              <h4 className="text-[13.5px] font-semibold">หัวข้อข่าวและการผูก LINE</h4>
                              <p className={`text-[11.5px] ${INK_2}`}>
                                เลือกหัวข้อ/ฟีดที่ติดตาม และผูกบัญชี LINE ที่รับข้อความ
                              </p>
                            </span>
                            <ExternalLink className="w-4 h-4 shrink-0" />
                          </Link>
                        </Row>
                      </>
                    )}
                    {nf?.error && <p className={`text-[11.5px] ${INK_2} pb-3`}>{nf.error}</p>}
                  </>
                )}

                {cat.id === "screen" && (
                  <>
                    <Row>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">ไม่ให้พักจอ</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>
                          {keepAwake.supported
                            ? "จอค้างไว้ตลอดที่เปิดแอป ทุกแท็บ เหมาะกับตอนวางดูตารางบนโต๊ะ"
                            : "เครื่องนี้ไม่รองรับ — ตั้งเวลาพักจอที่การตั้งค่าเครื่องแทน"}
                        </p>
                      </div>
                      <Sw
                        on={keepAwake.on}
                        onClick={keepAwake.toggle}
                        label="ไม่ให้พักจอ"
                        disabled={!keepAwake.supported}
                      />
                    </Row>
                    <Row last>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">ธีม</h4>
                        <p className={`text-[11.5px] ${INK_2}`}>
                          {theme.mode === "auto"
                            ? `ตามเครื่อง — ตอนนี้${theme.dark ? "มืด" : "สว่าง"}`
                            : "ใช้กับทุกหน้าของแอป จำไว้ในเครื่องนี้"}
                        </p>
                      </div>
                      <span className="flex gap-1 shrink-0">
                        {THEME_MODES.map((m: ThemeMode) => (
                          <button
                            key={m}
                            onClick={() => theme.setMode(m)}
                            aria-pressed={theme.mode === m}
                            className={`${NOTE_SM} ${PRESS} px-2 py-1 text-[12px] cursor-pointer ${
                              theme.mode === m ? N_GREEN : `${SURFACE} ${INK_3} shadow-none`
                            }`}
                          >
                            {THEME_LABEL[m]}
                          </button>
                        ))}
                      </span>
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
                          className={`${NOTE_SM} ${PRESS} ${SURFACE} px-2.5 py-1 text-[12.5px] shrink-0 cursor-pointer`}
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
                      <Link href="/line-link" className={`${NOTE_SM} ${PRESS} ${SURFACE} px-2.5 py-1 text-[12.5px] shrink-0`}>
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
                        {health === null ? (
                          <p className={`text-[11.5px] ${INK_2} flex items-center gap-1.5`}>
                            <Loader2 className="w-3 h-3 animate-spin" /> กำลังตรวจของจริงทั้งสามทาง…
                          </p>
                        ) : health.error ? (
                          <p className={`text-[11.5px] ${INK_2}`}>ตรวจไม่สำเร็จ: {health.error}</p>
                        ) : (
                          <ul className="flex flex-col gap-0.5 mt-0.5">
                            {(health.parts || []).map((p) => (
                              <li key={p.key} className={`text-[11.5px] ${INK_2} flex gap-1.5`}>
                                <span className="shrink-0 font-bold">
                                  {p.level === "ok" ? "✓" : p.level === "warn" ? "!" : "✕"}
                                </span>
                                <span>
                                  <b className="font-semibold">{p.name}</b> — {p.note}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <span
                        className={`${NOTE_SM} ${healthTint} px-2 py-0.5 font-hand text-[15px] font-bold shrink-0 self-start`}
                      >
                        {health === null ? dash : health.label}
                      </span>
                    </Row>
                    <Row last>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-[13.5px] font-semibold">เวอร์ชัน</h4>
                        {/* รหัสโค้ดสองฝั่ง — เอาไว้ตอบคำถามว่า "แก้แล้วทำไมยังเป็นเหมือนเดิม"
                            ถ้าสองค่าไม่ตรงกันคือจอยังรันของเก่า กดโหลดใหม่ได้ตรงนี้ */}
                        <p className={`text-[11.5px] ${INK_2}`}>
                          โค้ดในเครื่อง: {build.mine || "—"}
                          <br />
                          บนเซิร์ฟเวอร์: {build.live || "กำลังตรวจ…"}
                        </p>
                        <p className={`text-[11.5px] ${build.stale ? "font-semibold" : INK_3} mt-0.5`}>
                          {build.stale
                            ? "โค้ดในเครื่องเป็นรุ่นเก่า — กดโหลดใหม่เพื่อใช้รุ่นล่าสุด"
                            : build.live
                              ? "เป็นรุ่นล่าสุดแล้ว"
                              : ""}
                        </p>
                      </div>
                      <span className="flex flex-col items-end gap-1.5 shrink-0">
                        <span className={`${NOTE_SM} ${SURFACE} px-2 py-0.5 font-hand text-[15px] font-bold`}>
                          v3.0
                        </span>
                        <button
                          onClick={build.refresh}
                          className={`${NOTE_SM} ${PRESS} ${build.stale ? N_PINK : SURFACE} px-2.5 py-1 text-[12.5px] cursor-pointer`}
                        >
                          โหลดใหม่
                        </button>
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
