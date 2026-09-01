"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw,
  X,
  Eraser,
  MessageSquare,
  CalendarDays,
  ListChecks,
  SlidersHorizontal,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import ScheduleTab, { type CalEvent, type Room } from "@/components/ScheduleTab";
import TasksTab, { type Task } from "@/components/TasksTab";
import SettingsBoard, { type Health, type NotifyCfg, type SettingsData } from "@/components/SettingsBoard";
import AssistantTab from "@/components/AssistantTab";
import AssistantSheet from "@/components/AssistantSheet";
import { contextChipsForTab, type SheetTab } from "@/lib/sheetContextChips";
import { useKeepAwake } from "@/components/useKeepAwake";
import { useTheme } from "@/components/useTheme";
import { useFreshBuild } from "@/components/useFreshBuild";
import SplashScreen, { SPLASH_START, type SplashSteps } from "@/components/SplashScreen";
import { FirstRunSetup, NoLicenseNag, SetupNag, TourOverlay } from "@/components/Onboarding";
import { InboxBell, InboxSheet, useInbox, usePushRegister } from "@/components/Inbox";
import { NewsTopicsSheet } from "@/components/NewsTopics";
import {
  AssistantFace,
  authedGet,
  BOARD,
  FOLD,
  INK_2,
  INK_3,
  MicrosoftMark,
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

function LoginGate() {
  const { login } = useM365Auth();
  return (
    <div className={`min-h-screen ${BOARD} flex flex-col items-center justify-center p-7`}>
      <div className="w-full max-w-sm flex flex-col items-center">
        <div className="flex flex-col items-center gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/ktisx-reading-video.gif?v=8"
            alt="ผู้ช่วย KTIS X"
            className="w-[152px] h-[168px] object-contain"
          />
          <h1 className="font-marker text-[24px]">สวัสดีครับ</h1>
          <p className={`text-[13.5px] ${INK_2} text-center max-w-[260px] mt-0.5 leading-relaxed`}>
            ผมคือผู้ช่วยงานของคุณ เข้าสู่ระบบแล้วผมจะดึงตารางกับงานค้างมาให้ทันที
          </p>
        </div>

        {/* ลูกศรเขียนมือชี้ลงปุ่ม — หน้านี้มีงานให้ทำอย่างเดียว */}
        <div className="self-end flex items-end gap-1 mt-3.5 mr-11 -mb-1.5">
          <span className={`font-hand text-[16px] ${INK_3} -rotate-[4deg]`}>แตะที่นี่</span>
          <svg
            viewBox="0 0 46 40"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            className={`w-[46px] h-10 ${INK_3}`}
          >
            <path d="M4 4 C20 3 34 9 36 24 36.5 28 35 31.5 33 34" />
            <path d="M25 29 L33 34.6 L38 27" />
          </svg>
        </div>

        <button
          onClick={() => login()}
          className={`${N_BLUE} ${PRESS} w-full mt-1.5 px-[18px] py-[15px] flex items-center gap-3 text-left border-2 border-[var(--nb-ink)] rounded-[14px] shadow-[5px_5px_0_var(--nb-ink)] -rotate-[0.5deg] cursor-pointer`}
        >
          <MicrosoftMark />
          <span className="flex-1 font-semibold text-[14.5px]">เข้าสู่ระบบด้วย Microsoft 365</span>
          <span className="grid place-items-center w-7 h-7 border-2 border-[var(--nb-ink)] rounded-full text-[15px] leading-none shrink-0">
            →
          </span>
        </button>

        <div className="mt-4 text-center">
          <p className={`flex items-center justify-center gap-1.5 text-[12px] ${INK_3}`}>
            <span className="w-[7px] h-[7px] rounded-full bg-[var(--nb-ok)] shrink-0" />
            Microsoft Entra ID SSO · ไม่เก็บรหัสไว้ในแอป
          </p>
          <p className={`font-hand text-[15px] ${INK_3} mt-1`}>KTIS X · v2.7</p>
        </div>
      </div>
    </div>
  );
}


type TabKey = "chat" | "sched" | "task" | "set";

const TABS: { key: TabKey; label: string; tint: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "chat", label: "ผู้ช่วย AI", tint: N_BLUE, Icon: MessageSquare },
  { key: "sched", label: "ตาราง", tint: N_PURPLE, Icon: CalendarDays },
  { key: "task", label: "งาน", tint: N_GREEN, Icon: ListChecks },
  { key: "set", label: "ตั้งค่า", tint: N_ORANGE, Icon: SlidersHorizontal },
];

type NextUp = {
  subject: string;
  start: string;
  end: string;
  location: string;
  attendees: number;
} | null;

/** "2026-09-01T13:30:00.0000000" — เวลาไทยตรง ๆ ไม่ต้องแปลงโซน */
function wallDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

/**
 * นัดคนละวันต้องบอกวันด้วย ไม่งั้นขึ้นแค่ "13:30" แล้วอ่านเหมือนเป็นวันนี้
 * และนัดที่ "กำลังประชุมอยู่" คือสิ่งที่อยากเห็นที่สุด ไม่ใช่นัดพรุ่งนี้
 */
function whenLabel(e: NonNullable<NextUp>): { time: string; note: string } {
  const start = wallDate(e.start);
  const end = wallDate(e.end);
  const time = e.start.slice(11, 16);
  if (!start) return { time, note: "" };

  const now = new Date();
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((midnight(start) - midnight(now)) / 86_400_000);

  if (end && start <= now && now < end) return { time, note: "กำลังประชุมอยู่" };
  if (dayDiff === 0) return { time, note: "วันนี้" };
  if (dayDiff === 1) return { time, note: "พรุ่งนี้" };
  return {
    time,
    note: start.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" }),
  };
}

function AppShell() {
  const { account, getToken, getGraphToken } = useM365Auth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("chat");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [chatFocus, setChatFocus] = useState(false);
  const [sheetSeed, setSheetSeed] = useState<string | undefined>();
  const [sheetKey, setSheetKey] = useState(0);
  /* นับขึ้นทุกครั้งที่กดล้างความจำที่หัวเรื่อง */
  const [clearSignal, setClearSignal] = useState(0);

  /* ฉากโหลดดึงของจริงไว้แล้ว แท็บจึงรับไปใช้ต่อ ไม่ต้องยิงซ้ำ */
  const [steps, setSteps] = useState<SplashSteps>(SPLASH_START);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calErr, setCalErr] = useState("");
  const [rooms, setRooms] = useState<Room[] | null>(null);
  /* ห้องที่ดึงตอนเปิดแอปเป็นของวันไหน — เปิดค้างข้ามเที่ยงคืนแล้วแท็บตารางต้องรู้
     ว่าของที่มีอยู่เป็นของเมื่อวาน แล้วดึงใหม่เอง ไม่ใช่เอามาแปะใต้วันนี้ */
  const [roomsDate, setRoomsDate] = useState("");
  /* การตั้งค่าเก็บไว้ที่นี่ เปิดแท็บตั้งค่าจึงเห็นค่าเดิมทันทีทุกครั้ง ไม่ต้องโหลดซ้ำ */
  const [settings, setSettings] = useState<SettingsData>({
    settings: null,
    ms: null,
    notify: null,
    health: null,
  });

  /* งานที่ต้องติดตามอยู่ที่นี่ ไม่ใช่ในแท็บงาน — เปิดแท็บซ้ำจึงไม่มีรอบโหลดใหม่
     และตัวตามเก็บเงียบ ๆ ข้างล่างจะเอางานใหม่มาแสดงเองโดยไม่มีตัวหมุน */
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [taskErr, setTaskErr] = useState("");
  const [taskSync, setTaskSync] = useState(false);

  /* กันจอดับกับธีมต้องอยู่ที่นี่ ไม่ใช่ในหน้าตั้งค่า
     ตอนที่ฮุคอยู่ใน SettingsBoard พอสลับออกจากแท็บตั้งค่า คอมโพเนนต์ถูกถอด
     cleanup จึงปลดธงกันจอดับทิ้งทันที สวิตช์ขึ้นว่าเปิดแต่จอดับทุกที่นอกหน้านั้น */
  const keepAwake = useKeepAwake();
  const theme = useTheme();
  /* มี build ใหม่ขึ้นแล้วโหลดหน้าใหม่เอง — WebView ไม่โหลดใหม่ตอนเปิดจากรายการ
     แอปล่าสุด ทำให้ยังเจอบั๊กฝั่งหน้าจอที่แก้ไปแล้ว */
  const build = useFreshBuild();
  /* เข้าใช้ครั้งแรก — ค่าจากเซิร์ฟเวอร์บอกว่าเคยผ่านหน้าตั้งค่าหรือยัง
     ("" = ยังไม่เคย) ค่าที่เพิ่งกดในรอบนี้ทับของเซิร์ฟเวอร์ไว้ก่อน จะได้ไม่ต้อง
     รอโหลดใหม่ทั้งชุด */
  const [onbLocal, setOnbLocal] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [newsOpen, setNewsOpen] = useState(false);
  const inbox = useInbox();
  usePushRegister();
  const [tourOpen, setTourOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [booted, setBooted] = useState(false);
  /* ปิดป้ายบอกรุ่นใหม่ได้ แต่ผูกกับรหัส build ที่ปิดไป — deploy รอบหน้าป้ายกลับมาเอง */
  const [hidUpdateFor, setHidUpdateFor] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      // ถึงตรงนี้ได้แปลว่า MSAL คืน account มาแล้ว งานแรกจึงถือว่าเสร็จ
      if (!alive) return;
      setSteps((p) => ({ ...p, connect: "done", calendar: "run" }));

      let evs: CalEvent[] = [];
      try {
        const res = await authedGet<{ events?: CalEvent[]; error?: string }>(
          "/api/calendar/events",
          getToken,
          getGraphToken
        );
        evs = res.events || [];
        if (!alive) return;
        setEvents(evs);
        setSteps((p) => ({ ...p, calendar: res.error ? "fail" : "done", rooms: "run" }));
      } catch {
        if (!alive) return;
        setSteps((p) => ({ ...p, calendar: "fail", rooms: "run" }));
      }

      try {
        const [roomRes, setRes, msRes] = await Promise.all([
          authedGet<{ rooms?: Room[]; date?: string; error?: string }>("/api/rooms/status", getToken, getGraphToken),
          authedGet<SettingsData["settings"]>("/api/settings", getToken, getGraphToken).catch(
            (e) => ({ error: (e as Error).message })
          ),
          authedGet<SettingsData["ms"]>("/api/oauth/microsoft/status", getToken, getGraphToken).catch(
            (e) => ({ error: (e as Error).message })
          ),
        ]);
        if (!alive) return;
        setRooms(roomRes.rooms || []);
        setRoomsDate((roomRes.date || "").slice(0, 10));
        setSettings((prev) => ({ ...prev, settings: setRes, ms: msRes }));
        setSteps((p) => ({ ...p, rooms: roomRes.error ? "fail" : "done" }));
      } catch {
        if (!alive) return;
        setSteps((p) => ({ ...p, rooms: "fail" }));
      }

      // ดึงเสร็จก่อนเพดานเวลา — ค้างให้เห็นแถบเต็มแวบหนึ่งแล้วยกฉากออก
      setTimeout(() => alive && setLeaving(true), 380);
      setTimeout(() => alive && setBooted(true), 900);
    })();

    /* ตารางแจ้งเตือนกับสถานะระบบไม่กั้นฉากโหลด แต่ต้องมาถึงก่อนผู้ใช้เปิดแท็บ
       ตั้งค่า หน้านั้นจึงไม่มีรอบโหลดของตัวเอง (สถานะระบบต้องคุยกับ Entra และ
       LINE จริง จึงช้ากว่าค่าอื่นอยู่บ้าง) */
    void (async () => {
      const [nf, hp] = await Promise.all([
        authedGet<NotifyCfg>("/api/notify", getToken, getGraphToken).catch((e) => ({
          error: (e as Error).message,
        })),
        authedGet<Health>("/api/health", getToken, getGraphToken).catch((e) => ({
          error: (e as Error).message,
        })),
      ]);
      if (!alive) return;
      setSettings((prev) => ({
        ...prev,
        notify: "brief" in nf ? (nf as NotifyCfg) : prev.notify,
        health: "parts" in hp ? (hp as Health) : ({ ...hp, level: "warn", label: "ตรวจไม่ได้", parts: [] } as Health),
      }));
    })();

    // Graph บางครั้งใช้หลายวินาที ไม่กั้นผู้ใช้ไว้ที่ฉากโหลด — ปล่อยเข้าแอปก่อน
    // ที่เหลือดึงต่อเบื้องหลัง แท็บที่ยังไม่ได้ข้อมูลจะยิงเอง
    const capLeave = setTimeout(() => alive && setLeaving(true), 2200);
    const capBoot = setTimeout(() => alive && setBooted(true), 2700);

    return () => {
      alive = false;
      clearTimeout(capLeave);
      clearTimeout(capBoot);
    };
  }, [getToken, getGraphToken]);

  /**
   * ดึงงานที่ค้าง — `quiet` คือรอบที่ทำเองเบื้องหลัง ไม่ต้องขึ้นตัวหมุนให้ตาลาย
   *
   * ตอนที่ state อยู่ในแท็บงาน การสลับแท็บทำให้คอมโพเนนต์ถูกสร้างใหม่ทุกครั้ง
   * เห็น "กำลังโหลดงาน…" ซ้ำ ๆ ทั้งที่ข้อมูลเดิมยังใช้ได้อยู่
   */
  const loadTasks = useCallback(
    async (quiet = true) => {
      if (!quiet) setTaskSync(true);
      try {
        const res = await authedGet<{ tasks?: Task[]; error?: string }>(
          "/api/tasks?status=pending",
          getToken,
          getGraphToken
        );
        if (res.error) setTaskErr(res.error);
        else {
          setTaskErr("");
          setTasks(res.tasks || []);
        }
      } catch (e) {
        setTaskErr((e as Error).message);
      }
      if (!quiet) setTaskSync(false);
    },
    [getToken, getGraphToken]
  );

  /**
   * ดึงนัดจากปฏิทิน — `quiet` คือรอบเบื้องหลัง ไม่ต้องขึ้นตัวหมุน
   *
   * จองห้องเสร็จแล้วต้องเห็นนัดในแท็บตารางเลย ไม่ต้องกด "ซิงค์ M365" เอง
   */
  const loadEvents = useCallback(
    async (quiet = true) => {
      if (!quiet) {
        setCalBusy(true);
        setCalErr("");
      }
      try {
        const res = await authedGet<{ events?: CalEvent[]; error?: string; reply?: string }>(
          "/api/calendar/events",
          getToken,
          getGraphToken
        );
        if (res.error) setCalErr(res.reply || res.error);
        else {
          setCalErr("");
          setEvents(res.events || []);
        }
      } catch (e) {
        setCalErr((e as Error).message);
      }
      if (!quiet) setCalBusy(false);
    },
    [getToken, getGraphToken]
  );

  /* นัดที่เพิ่งเกิดขึ้น (จองเอง หรือคนอื่นส่งนัดมา) — ตามเก็บเงียบ ๆ ทุก 3 นาที
     และทุกครั้งที่กลับมาเห็นหน้าจอ */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void loadEvents(true);
    };
    const id = setInterval(tick, 180_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [loadEvents]);

  /* ตามเก็บงานใหม่ทุกนาที และทุกครั้งที่กลับมาเห็นหน้าจอ — เงียบ ๆ ไม่มีตัวหมุน
     หยุดถามตอนแอปถูกซ่อน จะได้ไม่ยิง Graph/Supabase ทิ้งตอนไม่มีใครดู */
  useEffect(() => {
    const tick = () => {
      // รอบตามเก็บข้ามไปเมื่อไม่มีใครดู แต่รอบแรกต้องดึงเสมอ — WebView รายงานว่า
      // ถูกซ่อนอยู่ได้ในจังหวะที่แอปเพิ่งเปิด แล้วรายการงานจะค้างว่างไปเลย
      if (document.visibilityState !== "visible") return;
      void loadTasks(true);
    };
    // ดึงจริงหลัง await เสมอ ไม่ใช่ setState ตรง ๆ ในตัว effect แต่กฎมองไม่เห็นข้ามฟังก์ชัน
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTasks(true);
    const id = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [loadTasks]);

  /** นัดที่ยังไม่จบ — ที่กำลังประชุมอยู่ต้องมาก่อนนัดพรุ่งนี้ */
  const next: NextUp = React.useMemo(() => {
    const now = new Date();
    const upcoming = (events || [])
      .filter((e) => {
        const end = wallDate(e.end);
        return !!end && end > now;
      })
      .sort((a, b) => a.start.localeCompare(b.start));
    return upcoming[0] || null;
  }, [events]);

  const sheetTab: SheetTab = tab === "chat" ? "sched" : tab;
  const contentHidden = sheetOpen && chatFocus;

  const openSheet = (seedText?: string) => {
    setSheetSeed(seedText);
    setSheetOpen(true);
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setChatFocus(false);
    setSheetSeed(undefined);
    setSheetKey((k) => k + 1);
  };

  const ask = (text: string) => {
    openSheet(text);
  };

  /* ── เข้าใช้ครั้งแรก ──────────────────────────────────────────────────
     จำที่เซิร์ฟเวอร์ว่าผ่านหน้าตั้งค่าแล้ว ไม่ใช่ที่เครื่อง — คนเดียวกันเปลี่ยน
     เครื่องหรือลงแอปใหม่จะได้ไม่โดนต้อนเข้าหน้าตั้งค่าซ้ำอีกรอบ */
  const onb = onbLocal ?? settings.settings?.onboarding ?? null;
  /* mailbox === false คือถามแล้วได้คำตอบชัดว่าไม่มีกล่องจดหมาย ไม่ใช่ถามไม่ได้ */
  const noLicense = settings.ms?.mailbox === false;
  const showSetup = setupOpen || onb === "";

  const postSettings = async (body: Record<string, unknown>) => {
    const token = await getToken();
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  };

  const finishSetup = (how: "done" | "skip") => {
    setSetupOpen(false);
    setOnbLocal(how);
    // ข้ามการตั้งค่า ไม่ได้แปลว่าข้ามการสอน — ยังพาเดินดูให้ก่อน
    setTourOpen(true);
    /* ขอ token กับ MSAL กินเวลาในจังหวะเดียวกับที่กดปุ่ม จอเลยค้างแวบหนึ่งก่อนจะ
       เปลี่ยนหน้า — ปล่อยให้วาดจอใหม่ก่อน แล้วค่อยยิงไปบันทึก (จำไม่ได้ก็แค่ขึ้น
       หน้าตั้งค่าใหม่รอบหน้า ไม่ใช่เรื่องที่ต้องขวางผู้ใช้ด้วยข้อความ error) */
    window.setTimeout(() => void postSettings({ onboarding: how }).catch(() => {}), 0);
  };

  const saveHours = (start: string, end: string, days: number[]) => {
    setSettings((p) => ({
      ...p,
      settings: { ...(p.settings || {}), work_start: start, work_end: end, work_days: days, hours_set: true },
    }));
    void postSettings({ work_start: start, work_end: end, work_days: days }).catch(() => {});
  };

  const saveBrief = async (time: string, enabled: boolean, days: number[]) => {
    setSettings((p) =>
      p.notify ? { ...p, notify: { ...p.notify, brief: { ...p.notify.brief, enabled, time, days } } } : p
    );
    const token = await getToken();
    await fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "brief", enabled, time, days }),
    }).catch(() => {});
  };

  /** ถอนสิทธิ์ปฏิทินที่เคยอนุญาตไว้ — กดผิดต้องเอาคืนได้ */
  const revokeCalendar = async () => {
    setSettings((p) => ({ ...p, ms: { ...(p.ms || {}), linked: false } }));
    const token = await getToken();
    await fetch("/api/oauth/microsoft/status", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  };

  const grantCalendar = async () => {
    const token = await getToken();
    if (!token) return;
    window.location.href = `/api/oauth/microsoft/start?token=${encodeURIComponent(token)}&back=/`;
  };

  return (
    <div className={`h-screen [height:100dvh] overflow-hidden ${BOARD} flex flex-col`}>
      {!contentHidden && (

      <header className="sticky top-0 z-30 px-4 py-3 border-b-2 border-[var(--nb-ink)] bg-[var(--nb-surface)] flex items-center gap-3 shrink-0">
        <AssistantFace className="w-9 h-9" />
        <div className="flex-1 min-w-0">
          <div className="font-marker text-[16px] leading-tight">ผู้ช่วยงาน KTIS X</div>
          <div className={`font-hand text-[14px] truncate ${INK_2}`}>{account?.username}</div>
        </div>
        {/* ล้างความจำมาอยู่มุมขวาของหัวเรื่อง — ที่เก่าเป็นปุ่มลอยใหม่ทับแชทอยู่
            เห็นเฉพาะแท็บแชท เพราะแท็บอื่นไม่มีความจำให้ล้าง */}
        <InboxBell unread={inbox.unread} onClick={() => setInboxOpen(true)} />
        {tab === "chat" && (
          <button
            type="button"
            onClick={() => setClearSignal((n) => n + 1)}
            title="ล้างความจำการสนทนา"
            aria-label="ล้างความจำ"
            data-tour="chat-clear"
            className={`${NOTE_SM} ${PRESS} ${N_PINK} shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold cursor-pointer`}
          >
            <Eraser className="w-3.5 h-3.5" /> ล้าง
          </button>
        )}
      </header>

      )}

      {/* มีรุ่นใหม่บนเซิร์ฟเวอร์แล้วต้องบอกตรงนี้ ไม่ใช่ปล่อยให้ไปเจอเองในหน้าตั้งค่า
          โหลดใหม่เองได้เฉพาะจังหวะที่ปลอดภัย (เพิ่งเปิดแอป หรือสลับกลับเข้ามา)
          ถ้าผู้ใช้กำลังใช้งานอยู่ก็ตัดจบกลางทางไม่ได้ — ได้แค่บอกแล้วให้กดเอง */}
      {!contentHidden && build.stale && hidUpdateFor !== build.live && (
        <div
          role="status"
          className={`${NOTE_SM} ${N_YELLOW} shrink-0 mx-4 mt-3 px-3 py-2 flex items-center gap-2`}
        >
          <RefreshCw className="w-4 h-4 shrink-0" />
          <span className="flex-1 min-w-0 text-[12.5px] leading-snug">
            มีรุ่นใหม่ของแอปแล้ว
          </span>
          <button
            type="button"
            onClick={build.refresh}
            className={`${NOTE_SM} ${PRESS} bg-[var(--nb-surface)] shrink-0 px-2.5 py-1 font-hand text-[14px] font-bold cursor-pointer`}
          >
            โหลดใหม่
          </button>
          <button
            type="button"
            onClick={() => setHidUpdateFor(build.live)}
            aria-label="ปิดข้อความนี้"
            className={`${INK_2} shrink-0 p-1 cursor-pointer`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {!contentHidden && noLicense && <NoLicenseNag />}

      {!contentHidden && onb === "skip" && !settings.ms?.linked && (
        <SetupNag onOpen={() => setSetupOpen(true)} />
      )}

      {!contentHidden && tab === "chat" && next && (
        <button
          onClick={() => setTab("sched")}
          className={`${NOTE} ${FOLD} ${N_BLUE} ${PRESS} shrink-0 mx-4 mt-4 px-4 py-3 flex items-center gap-3 text-left -rotate-[0.6deg] cursor-pointer`}
        >
          <span className="shrink-0 text-center">
            <span className="block font-hand text-[20px] font-bold leading-none">
              {whenLabel(next).time}
            </span>
            <span className={`block font-hand text-[14px] ${INK_2}`}>{whenLabel(next).note}</span>
          </span>
          <span className="flex-1 min-w-0">
            <span className="block font-semibold text-[14px] leading-snug truncate">{next.subject}</span>
            <span className={`block text-[12px] truncate ${INK_2}`}>
              {[next.location, next.attendees ? `${next.attendees} ท่าน` : ""].filter(Boolean).join(" · ") ||
                "นัดถัดไปของคุณ"}
            </span>
          </span>
          <span className={`font-hand text-[15px] shrink-0 ${INK_3}`}>ดูปฏิทิน →</span>
        </button>
      )}

      {!contentHidden && (
        <>
          {/* แชทไม่ถูกถอดตอนสลับแท็บ แค่ซ่อน — บทสนทนาและสถานะที่ล้างไปจึงอยู่ตามเดิม */}
          <div className={tab === "chat" ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
            <AssistantTab
              canTest={(settings.settings?.perms || []).includes("test.cmds")}
              onBooked={() => void loadEvents(true)}
              clearSignal={clearSignal}
            />
          </div>
          {tab === "sched" && (
            <ScheduleTab
              events={events}
              busy={calBusy}
              err={calErr}
              onReload={() => void loadEvents(false)}
              initialRooms={rooms}
              initialRoomsDate={roomsDate}
              onAsk={ask}
            />
          )}
          {tab === "task" && (
            <TasksTab
              tasks={tasks}
              err={taskErr}
              syncing={taskSync}
              onChange={setTasks}
              onReload={() => void loadTasks(false)}
            />
          )}
          {tab === "set" && (
            <SettingsBoard
              data={settings}
              onChange={setSettings}
              keepAwake={keepAwake}
              theme={theme}
              build={build}
              onReplayTour={() => setTourOpen(true)}
              onOpenSetup={() => setSetupOpen(true)}
            />
          )}
        </>
      )}

      <AssistantSheet
        open={sheetOpen}
        chatFocus={chatFocus}
        contextChips={contextChipsForTab(sheetTab)}
        seed={sheetSeed}
        onSeedUsed={() => setSheetSeed(undefined)}
        onClose={closeSheet}
        onShowWork={() => setChatFocus(false)}
        onUserSend={() => setChatFocus(true)}
        clearSignal={clearSignal}
        canTest={(settings.settings?.perms || []).includes("test.cmds")}
        onBooked={() => void loadEvents(true)}
        instanceKey={sheetKey}
      />

      <nav className="sticky bottom-0 z-30 grid grid-cols-4 border-t-2 border-[var(--nb-ink)] bg-[var(--nb-surface)] px-1.5 pt-2 pb-[max(0.625rem,env(safe-area-inset-bottom))] shrink-0">
        {TABS.map(({ key, label, tint, Icon }) => {
          const on = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-current={on ? "page" : undefined}
              data-tour={`tab-${key}`}
              className={`flex flex-col items-center gap-1 py-0.5 cursor-pointer ${on ? "" : INK_3}`}
            >
              <span
                className={`relative grid place-items-center w-11 h-[30px] rounded-[10px] border-2 transition-transform ${
                  on
                    ? `${tint} border-[var(--nb-ink)] shadow-[2px_2px_0_var(--nb-ink)] -rotate-3`
                    : "border-transparent"
                }`}
              >
                <Icon className="w-5 h-5" />
                {/* จำนวนงานค้าง — บอกว่ามีงานใหม่เข้ามาโดยไม่ต้องเด้งอะไรขึ้นมาขวาง */}
                {key === "task" && !!tasks?.length && (
                  <span
                    className={`absolute -top-1 -right-0.5 min-w-[17px] h-[17px] px-1 grid place-items-center rounded-full border-2 border-[var(--nb-ink)] ${N_PINK} text-[10px] font-bold leading-none text-[var(--nb-ink)]`}
                  >
                    {tasks.length > 9 ? "9+" : tasks.length}
                  </span>
                )}
              </span>
              <span className={`text-[11px] ${on ? "font-semibold" : ""}`}>{label}</span>
            </button>
          );
        })}
      </nav>

      {newsOpen && <NewsTopicsSheet onClose={() => setNewsOpen(false)} />}

      {inboxOpen && (
        <InboxSheet
          notices={inbox.notices}
          loaded={inbox.loaded}
          onRead={(id) => void inbox.markRead(id)}
          onClose={() => setInboxOpen(false)}
        />
      )}

      {showSetup && booted && (
        <FirstRunSetup
          msLinked={!!settings.ms?.linked}
          noLicense={noLicense}
          lineLinked={false}
          hoursSet={!!settings.settings?.hours_set}
          workStart={settings.settings?.work_start || ""}
          workEnd={settings.settings?.work_end || ""}
          briefOn={!!settings.notify?.brief?.enabled}
          briefTime={settings.notify?.brief?.time || "07:30"}
          newsOn={!!settings.notify?.news?.enabled}
          onOpenNews={() => setNewsOpen(true)}
          onSaveHours={saveHours}
          briefDays={settings.notify?.brief?.days || []}
          workDays={settings.settings?.work_days || []}
          onSaveBrief={(t, on, d) => void saveBrief(t, on, d)}
          onRevoke={() => void revokeCalendar()}
          onGrant={() => void grantCalendar()}
          onFinish={finishSetup}
        />
      )}

      {tourOpen && !showSetup && booted && (
        <TourOverlay
          onTab={setTab}
          onClose={() => {
            setTourOpen(false);
            // จบทัวร์ที่แท็บตั้งค่า แล้วปล่อยให้ค้างอยู่ตรงนั้น คนใช้ต้องมาหาแท็บแชทเอง
            setTab("chat");
          }}
        />
      )}

      {!booted && (
        <SplashScreen steps={steps} eventCount={events?.length} leaving={leaving} />
      )}
    </div>
  );
}

function HomeGate() {
  const { ready, isAuthenticated } = useM365Auth();

  // ระหว่าง MSAL กู้ session — ฉากโหลดค้างที่งานแรก
  if (!ready) return <SplashScreen steps={SPLASH_START} />;
  if (!isAuthenticated) return <LoginGate />;
  return <AppShell />;
}

export default function Home() {
  return (
    <M365AuthProvider>
      <HomeGate />
    </M365AuthProvider>
  );
}
