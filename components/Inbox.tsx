"use client";

/**
 * กล่องแจ้งเตือนในแอป
 *
 * เดิมทุกอย่างที่ผู้ช่วยส่ง ไปทาง LINE ทางเดียว — ใครยังไม่ได้เชื่อม LINE หรือ
 * โควตา push เดือนนั้นหมด ก็ไม่เคยรู้ว่ามีอะไรส่งมา และต่อให้ได้รับ พอเลื่อนแชท
 * ไปไกลก็หาย้อนไม่เจอ กล่องนี้เก็บสำเนาทุกฉบับไว้ให้อ่านย้อนหลังในแอป
 */

import { useCallback, useEffect, useState } from "react";
import { Bell, X, CalendarDays, ListChecks, Newspaper, Sunrise, Info } from "lucide-react";
import { useM365Auth } from "@/components/M365AuthProvider";
import {
  INK_2,
  INK_3,
  N_BLUE,
  N_GREEN,
  N_PINK,
  N_PURPLE,
  N_YELLOW,
  NOTE,
  NOTE_SM,
  PRESS,
} from "@/components/noteStyles";

export type Notice = {
  id: string;
  kind: "brief" | "news" | "task" | "meeting" | "system";
  title: string;
  body: string;
  at: number;
  read?: number;
};

const LOOK = {
  brief: { Icon: Sunrise, tint: N_YELLOW },
  news: { Icon: Newspaper, tint: N_PURPLE },
  task: { Icon: ListChecks, tint: N_GREEN },
  meeting: { Icon: CalendarDays, tint: N_BLUE },
  system: { Icon: Info, tint: N_PINK },
} as const;

/** เช็คทุก 2 นาที และทุกครั้งที่กลับมาดูหน้าจอ — ของใหม่มาระหว่างพักแอปจะได้ขึ้นเอง */
const POLL_MS = 2 * 60_000;

export function useInbox() {
  const { getToken, isAuthenticated } = useM365Auth();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const token = await getToken();
      if (!token) return;
      const r = await fetch("/api/notifications", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = (await r.json()) as { notices?: Notice[] };
      setNotices(j.notices || []);
      setLoaded(true);
    } catch {
      /* ออฟไลน์ก็ไม่ต้องทำอะไร รอบหน้าค่อยลองใหม่ */
    }
  }, [getToken, isAuthenticated]);

  useEffect(() => {
    // ยิงรอบแรกในจังหวะถัดไป ไม่ใช่ในตัวเอฟเฟกต์ตรง ๆ — กันไม่ให้ไปตั้งค่า state
    // ระหว่างที่ React ยังวาดรอบแรกไม่เสร็จ
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const markRead = useCallback(
    async (id: string) => {
      const now = Date.now();
      setNotices((p) => p.map((n) => (id === "all" || n.id === id ? { ...n, read: n.read ?? now } : n)));
      try {
        const token = await getToken();
        await fetch("/api/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ read: id }),
        });
      } catch {
        /* ทำเครื่องหมายไม่สำเร็จก็แค่ขึ้นว่ายังไม่อ่านรอบหน้า */
      }
    },
    [getToken]
  );

  return { notices, unread: notices.filter((n) => !n.read).length, loaded, refresh: load, markRead };
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "วันนี้";
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (same(d, y)) return "เมื่อวาน";
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });

/** ปุ่มกระดิ่งพร้อมเลขที่ยังไม่ได้อ่าน */
export function InboxBell({ unread, onClick }: { unread: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={unread ? `แจ้งเตือน ${unread} รายการใหม่` : "แจ้งเตือน"}
      className={`${NOTE_SM} ${PRESS} ${unread ? N_YELLOW : "bg-[var(--nb-surface)]"} relative shrink-0 grid place-items-center w-8 h-8 cursor-pointer`}
    >
      <Bell className="w-4 h-4" />
      {unread > 0 && (
        <span
          className={`absolute -top-1.5 -right-1.5 min-w-[17px] h-[17px] px-1 grid place-items-center rounded-full border-2 border-[var(--nb-ink)] ${N_PINK} text-[10px] font-bold leading-none`}
        >
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

export function InboxSheet({
  notices,
  loaded,
  onRead,
  onClose,
}: {
  notices: Notice[];
  loaded: boolean;
  onRead: (id: string) => void;
  onClose: () => void;
}) {
  const [openId, setOpenId] = useState("");
  const unread = notices.filter((n) => !n.read).length;

  // จัดกลุ่มตามวัน — ของวันนี้อยู่บนสุด
  const groups: { day: string; rows: Notice[] }[] = [];
  for (const n of notices) {
    const day = dayLabel(n.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(n);
    else groups.push({ day, rows: [n] });
  }

  return (
    <div className="fixed inset-0 z-[52] flex flex-col bg-[var(--nb-board)]" role="dialog" aria-label="แจ้งเตือน">
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b-2 border-[var(--nb-ink)] bg-[var(--nb-surface)]">
        <h2 className="font-marker text-[17px] flex-1">แจ้งเตือน</h2>
        {unread > 0 && (
          <button
            type="button"
            onClick={() => onRead("all")}
            className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] px-2.5 py-1 text-[12px] cursor-pointer`}
          >
            อ่านทั้งหมด
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="ปิด"
          className={`${NOTE_SM} ${PRESS} ${N_PINK} grid place-items-center w-8 h-8 shrink-0 cursor-pointer`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 max-w-md w-full mx-auto">
        {!loaded && <p className={`font-hand text-[16px] ${INK_2} text-center py-6`}>กำลังเปิดกล่อง…</p>}

        {loaded && !notices.length && (
          <div className={`${NOTE} bg-[var(--nb-surface)] px-4 py-7 text-center`}>
            <p className="font-hand text-[17px]">ยังไม่มีแจ้งเตือนครับ</p>
            <p className={`text-[12px] ${INK_2} mt-1`}>
              สรุปงานเช้า ข่าวประจำวัน และเตือนงานถึงกำหนด จะมาเก็บไว้ที่นี่ให้ย้อนอ่านได้
            </p>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.day} className="space-y-2">
            <p className={`font-hand text-[16px] ${INK_2} px-1`}>{g.day}</p>
            {g.rows.map((n) => {
              const look = LOOK[n.kind] || LOOK.system;
              const Icon = look.Icon;
              const open = openId === n.id;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    setOpenId(open ? "" : n.id);
                    if (!n.read) onRead(n.id);
                  }}
                  className={`${NOTE} ${PRESS} ${n.read ? "bg-[var(--nb-surface)]" : look.tint} w-full px-3 py-2.5 flex gap-2.5 text-left cursor-pointer`}
                >
                  <span
                    className={`shrink-0 w-[30px] h-[30px] grid place-items-center rounded-[9px] border-2 border-[var(--nb-ink)] ${look.tint}`}
                  >
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-baseline gap-2">
                      <b className="flex-1 min-w-0 text-[13.5px] font-semibold truncate">{n.title}</b>
                      <span className={`font-hand text-[14px] shrink-0 ${INK_3}`}>{clock(n.at)}</span>
                    </span>
                    <span
                      className={`block text-[12px] leading-[1.5] whitespace-pre-wrap ${INK_2} ${
                        open ? "" : "line-clamp-2"
                      }`}
                    >
                      {n.body}
                    </span>
                    {!open && n.body.length > 90 && (
                      <span className={`block font-hand text-[14px] mt-0.5 ${INK_3}`}>แตะเพื่ออ่านทั้งหมด</span>
                    )}
                  </span>
                  {!n.read && (
                    <span className="shrink-0 w-2.5 h-2.5 rounded-full bg-[var(--nb-ink)] mt-1.5" aria-label="ยังไม่อ่าน" />
                  )}
                </button>
              );
            })}
          </div>
        ))}

        {loaded && !!notices.length && (
          <p className={`font-hand text-[15px] ${INK_3} text-center pt-1`}>เก็บย้อนหลัง 30 วัน</p>
        )}
      </div>
    </div>
  );
}
