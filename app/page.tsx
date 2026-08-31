"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Send,
  MapPin,
  FileText,
  Folder,
  Eraser,
  MessageSquare,
  CalendarDays,
  ListChecks,
  SlidersHorizontal,
} from "lucide-react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { appendChatTurns, chatMemoryExpired, pruneChatHistory, type ChatTurn } from "@/lib/chatMemory";
import { SLASH_COMMANDS, isSlashMenu, matchSlashCommand, parseSlashCommand, slashToUserText } from "@/lib/slashCommands";
import ScheduleTab, { type CalEvent, type Room } from "@/components/ScheduleTab";
import TasksTab from "@/components/TasksTab";
import SettingsBoard, { type Health, type NotifyCfg, type SettingsData } from "@/components/SettingsBoard";
import { useKeepAwake } from "@/components/useKeepAwake";
import { useTheme } from "@/components/useTheme";
import SplashScreen, { SPLASH_START, type SplashSteps } from "@/components/SplashScreen";
import {
  AssistantFace,
  authedGet,
  BOARD,
  CHIP_TINTS,
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

type Slot = { start: string; end: string; label: string };
type Choice = { mail?: string; displayName?: string; period?: string; event_id?: string; label?: string; index?: number };
type FileHit = { id?: string; name?: string; url?: string; is_folder?: boolean };

type ApiResult = {
  intent: string;
  reply: string;
  slots?: Slot[];
  choices?: Choice[];
  files?: FileHit[];
  meeting?: { attendees: string[]; duration: number; subject: string };
  person?: { mail: string; displayName?: string };
  map_url?: string | null;
  error?: string;
};

type Msg = {
  role: "me" | "bot";
  text: string;
  slots?: Slot[];
  choices?: Choice[];
  files?: FileHit[];
  intent?: string;
  mapUrl?: string | null;
};

const SUGGESTIONS = [
  "/",
  "/ล้างความจำ",
  "/ตารางวันนี้",
  "/นัดพรุ่งนี้",
  "/ตั้งค่าข่าว",
];

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

function AssistantTab({ seed }: { seed?: string }) {
  const { getToken, getGraphToken } = useM365Auth();
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "bot", text: "สวัสดีครับ 👋 ผมคือผู้ช่วย AI ของคุณ\nถามเรื่องนัดประชุม งานค้าง เวลาว่าง หรือสั่งนัดประชุมได้เลยครับ" },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const ctxRef = useRef<{
    last_intent?: string;
    last_person?: string;
    last_person_mail?: string;
    last_activity_ts?: number;
    summary?: string;
    files?: FileHit[];
    selected?: { start: string; person?: { mail?: string; displayName?: string } };
    meeting?: { attendees: string[]; duration: number; subject: string; window?: { start: string; end: string; label: string } };
    last_meeting?: { attendees: string[]; duration: number; subject?: string; window?: { start: string; end: string; label: string } };
    history: ChatTurn[];
  }>({ history: [] });
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);


  const addMsg = (m: Msg) => setMsgs((prev) => [...prev, m]);

  const api = async (path: string, body: Record<string, unknown>): Promise<ApiResult> => {
    const token = await getToken();
    if (!token) throw new Error("กรุณาเข้าสู่ระบบ Microsoft 365 ก่อนครับ");
    // Graph access token (optional) — calendar then follows your M365/Outlook rights.
    const graphToken = (await getGraphToken()) || undefined;
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, graphToken }),
    });
    return r.json();
  };

  const applyResult = (res: ApiResult) => {
    const ctx = ctxRef.current;
    const now = Date.now();
    if (res.intent === "clear_memory") {
      ctx.history = [];
      ctx.summary = undefined;
      ctx.last_intent = undefined;
      ctx.last_person = undefined;
      ctx.last_person_mail = undefined;
      ctx.last_meeting = undefined;
      ctx.meeting = undefined;
      ctx.files = undefined;
      ctx.selected = undefined;
      ctx.last_activity_ts = now;
      addMsg({ role: "bot", text: res.reply || "ล้างความจำการสนทนาแล้วครับ — เริ่มเรื่องใหม่ได้เลย 🧹" });
      return;
    }
    ctx.last_intent = res.intent;
    ctx.last_activity_ts = now;
    if (res.person?.mail) {
      ctx.last_person_mail = res.person.mail;
      ctx.last_person = res.person.displayName || res.person.mail;
    }
    if (res.files) ctx.files = res.files;
    if (res.meeting) {
      ctx.meeting = res.meeting as typeof ctx.meeting;
      if ((res.meeting as { attendees?: string[] }).attendees?.length) {
        ctx.last_meeting = res.meeting as typeof ctx.last_meeting;
      }
    }
    const pruned = pruneChatHistory(appendChatTurns(ctx.history, undefined, res.reply || "", now), ctx.summary, now);
    ctx.history = pruned.history;
    ctx.summary = pruned.summary;
    addMsg({
      role: "bot",
      text: res.reply || res.error || "…",
      slots: res.slots,
      choices: res.choices,
      files: res.files,
      intent: res.intent,
      mapUrl: res.map_url,
    });
  };

  const send = async (text?: string) => {
    const original = (text ?? input).trim();
    let t = original;
    if (!t || busy) return;
    setInput("");
    setBusy(true);

    // Slash menu / commands (same as LINE — always override mid-flow)
    if (isSlashMenu(t)) {
      addMsg({ role: "me", text: t });
      addMsg({
        role: "bot",
        text:
          "เลือกคำสั่งได้เลยครับ\n\n" +
          SLASH_COMMANDS.map((c, i) => `${i + 1}) /${c.cmd} — ${c.hint}`).join("\n"),
        choices: SLASH_COMMANDS.map((c) => ({ label: c.message, displayName: c.label })),
        intent: "slash_menu",
      });
      setBusy(false);
      return;
    }
    const slashBody = parseSlashCommand(t);
    if (slashBody) {
      const cmd = matchSlashCommand(slashBody);
      if (!cmd) {
        addMsg({ role: "me", text: t });
        addMsg({
          role: "bot",
          text: `ไม่รู้จักคำสั่ง /${slashBody} ครับ\nพิมพ์ / เพื่อดูรายการคำสั่ง`,
          choices: SLASH_COMMANDS.map((c) => ({ label: c.message, displayName: c.label })),
          intent: "slash_menu",
        });
        setBusy(false);
        return;
      }
      if (cmd.cmd === "ล้างความจำ") {
        addMsg({ role: "me", text: t });
        clearMemory();
        setBusy(false);
        return;
      }
      if (cmd.cmd === "ยกเลิก") {
        addMsg({ role: "me", text: t });
        ctxRef.current.selected = undefined;
        addMsg({ role: "bot", text: "ยกเลิกงานที่ค้างไว้แล้วครับ — พิมพ์ / เพื่อเลือกคำสั่ง" });
        setBusy(false);
        return;
      }
      t = slashToUserText(cmd);
    }

    addMsg({ role: "me", text: original });
    const ctx = ctxRef.current;
    const now = Date.now();
    // Idle > 30 min → brand-new topic
    if (chatMemoryExpired(ctx.last_activity_ts, now)) {
      ctx.history = [];
      ctx.summary = undefined;
      ctx.last_intent = undefined;
      ctx.last_person = undefined;
      ctx.last_person_mail = undefined;
      ctx.last_meeting = undefined;
      ctx.meeting = undefined;
      ctx.files = undefined;
      ctx.selected = undefined;
    } else {
      const pruned = pruneChatHistory(ctx.history, ctx.summary, now);
      ctx.history = pruned.history;
      ctx.summary = pruned.summary;
    }
    ctx.history = appendChatTurns(ctx.history, t, undefined, now);
    ctx.last_activity_ts = now;
    try {
      const res = await api("/api/command", {
        text: t,
        context: {
          history: ctx.history,
          summary: ctx.summary,
          last_intent: ctx.last_intent,
          last_person: ctx.last_person,
          last_person_mail: ctx.last_person_mail,
          last_meeting: ctx.last_meeting,
          files: ctx.files,
          selected: ctx.selected,
        },
      });
      ctx.selected = undefined;
      applyResult(res);
    } catch (e) {
      addMsg({ role: "bot", text: `⚠️ ${(e as Error).message}` });
    }
    setBusy(false);
  };

  /* คำสั่งที่ถูกส่งมาจากแท็บอื่น — ยิงเข้าแชทครั้งเดียวต่อคำสั่ง */
  const seededRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (seed && seededRef.current !== seed) {
      seededRef.current = seed;
      void send(seed);
    }
    // send เปลี่ยนทุก render โดยตั้งใจ — ผูกกับ seed อย่างเดียวพอ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const pickSlot = async (slot: Slot, intent?: string) => {
    if (busy) return;
    const ctx = ctxRef.current;
    if ((intent === "choose_slot" || intent === "confirm_meeting") && ctx.meeting) {
      setBusy(true);
      addMsg({ role: "me", text: intent === "confirm_meeting" ? `ยืนยันส่งนัด ${slot.label}` : `เลือกช่วง ${slot.label}` });
      try {
        const res = await api("/api/meetings/book", {
          subject: ctx.meeting.subject,
          start: slot.start,
          end: slot.end,
          attendees: ctx.meeting.attendees,
        });
        addMsg({
          role: "bot",
          text: res.error
            ? `⚠️ จองไม่สำเร็จ: ${res.error}`
            : `✅ ส่งนัดแล้ว!\n📌 ${ctx.meeting.subject}\n🕐 ${slot.label}`,
        });
      } catch (e) {
        addMsg({ role: "bot", text: `⚠️ ${(e as Error).message}` });
      }
      setBusy(false);
    } else {
      ctx.selected = { start: slot.start, person: { mail: ctx.last_person_mail, displayName: ctx.last_person } };
      addMsg({ role: "me", text: `เลือกช่วง ${slot.label}` });
      addMsg({ role: "bot", text: "รับทราบครับ พิมพ์สั่งได้เลย เช่น “จองเลย” หรือ “นัด 1 ชั่วโมง เรื่อง...”" });
    }
  };

  const pickChoice = async (c: Choice, intent?: string) => {
    if (busy) return;
    if (intent === "slash_menu") {
      const cmd = c.label || c.displayName;
      if (cmd) void send(cmd);
      return;
    }
    setBusy(true);
    try {
      if (intent === "choose_person" && c.mail) {
        addMsg({ role: "me", text: `เลือก ${c.displayName || c.mail}` });
        const res = await api("/api/availability", { email: c.mail, who: c.displayName || c.mail, period: c.period || "week" });
        applyResult(res);
      } else if (intent === "choose_cancel" && c.event_id) {
        addMsg({ role: "me", text: `ยกเลิก: ${c.label}` });
        const res = await api("/api/meetings/cancel", { event_id: c.event_id });
        addMsg({ role: "bot", text: res.error ? `⚠️ ${res.error}` : "✅ ยกเลิกนัดเรียบร้อยแล้วครับ" });
      } else if (intent === "choose_meeting" && c.event_id) {
        addMsg({ role: "me", text: `สรุป: ${c.label}` });
        addMsg({ role: "bot", text: "🔎 กำลังดึง transcript และสรุปให้ครับ รอสักครู่…" });
        const res = (await api("/api/summaries/one", { event_id: c.event_id })) as ApiResult & {
          ok?: boolean;
          summary?: string;
          reason?: string;
          added?: number;
        };
        if (res.ok) {
          let text = res.summary || "";
          if (res.added) text += `\n\n(บันทึกงานติดตามใหม่ ${res.added} รายการ)`;
          addMsg({ role: "bot", text });
        } else {
          addMsg({ role: "bot", text: `⚠️ ${res.reason || res.error || "สรุปไม่สำเร็จ"}` });
        }
      } else if (intent === "choose_prep" && (c.index || c.event_id)) {
        const n = c.index || 0;
        addMsg({ role: "me", text: `เตรียมนัด ${n || ""} ${c.label || ""}`.trim() });
        addMsg({ role: "bot", text: "🔎 กำลังอ่านรายละเอียดนัด/ไฟล์แนบแล้วแนะนำให้ครับ…" });
        const res = await api("/api/command", {
          text: n ? `เตรียมนัด ${n}` : `เตรียมนัด ${c.label}`,
          context: { last_intent: "choose_prep" },
        });
        applyResult(res);
      }
    } catch (e) {
      addMsg({ role: "bot", text: `⚠️ ${(e as Error).message}` });
    }
    setBusy(false);
  };

  const clearMemory = () => {
    const ctx = ctxRef.current;
    ctx.history = [];
    ctx.summary = undefined;
    ctx.last_intent = undefined;
    ctx.last_person = undefined;
    ctx.last_person_mail = undefined;
    ctx.last_meeting = undefined;
    ctx.meeting = undefined;
    ctx.files = undefined;
    ctx.selected = undefined;
    ctx.last_activity_ts = Date.now();
    setMsgs([
      {
        role: "bot",
        text: "ล้างความจำการสนทนาแล้วครับ — เริ่มเรื่องใหม่ได้เลย 🧹\n(หรือพิมพ์ / แล้วเลือก /ล้างความจำ ก็ได้)",
      },
    ]);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <main className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "me" ? "justify-end" : "justify-start gap-2 items-end"}`}>
            {m.role === "bot" && <AssistantFace className="w-8 h-8" />}
            <div
              className={`${NOTE} max-w-[82%] px-4 py-3 text-[14px] whitespace-pre-wrap leading-relaxed ${
                m.role === "me" ? `${N_YELLOW} rotate-[0.4deg]` : `bg-[var(--nb-surface)] ${FOLD} -rotate-[0.4deg]`
              }`}
            >
              {m.text}
              {m.mapUrl && (
                <a
                  href={m.mapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`${NOTE_SM} ${N_BLUE} mt-2.5 inline-flex items-center gap-1.5 px-2.5 py-1 font-hand text-[15px] font-bold`}
                >
                  <MapPin className="w-3.5 h-3.5" /> เปิดแผนที่ / เส้นทาง
                </a>
              )}
              {!!m.files?.length && (
                <div className="mt-2.5 flex flex-col gap-1.5">
                  {m.files.slice(0, 8).map((f, j) => (
                    <a
                      key={j}
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`${NOTE_SM} ${N_GREEN} flex items-center gap-2 px-2.5 py-1.5 text-[13px] truncate`}
                    >
                      {f.is_folder ? (
                        <Folder className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <FileText className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span className="truncate">{f.name}</span>
                    </a>
                  ))}
                </div>
              )}
              {!!m.slots?.length && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {m.slots.slice(0, 10).map((s, j) => (
                    <button
                      key={j}
                      onClick={() => pickSlot(s, m.intent)}
                      className={`${NOTE_SM} ${PRESS} ${N_BLUE} px-2.5 py-1 font-hand text-[15px] font-bold cursor-pointer`}
                    >
                      {m.intent === "confirm_meeting" ? `ยืนยัน ${s.label}` : s.label}
                    </button>
                  ))}
                </div>
              )}
              {!!m.choices?.length && (
                <div className="mt-2.5 flex flex-col gap-2">
                  {m.choices.slice(0, 10).map((c, j) => (
                    <button
                      key={j}
                      onClick={() => pickChoice(c, m.intent)}
                      className={`${NOTE_SM} ${PRESS} ${N_PURPLE} text-left px-3 py-1.5 text-[13.5px] cursor-pointer`}
                    >
                      {c.label || c.displayName || c.mail}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start gap-2 items-end">
            <AssistantFace className="w-8 h-8" />
            <div className={`${NOTE} bg-[var(--nb-surface)] px-4 py-3.5 flex gap-1.5`}>
              <i className="w-[7px] h-[7px] rounded-full bg-[var(--nb-ink)] animate-bounce [animation-delay:0ms]" />
              <i className="w-[7px] h-[7px] rounded-full bg-[var(--nb-ink)] animate-bounce [animation-delay:150ms]" />
              <i className="w-[7px] h-[7px] rounded-full bg-[var(--nb-ink)] animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="px-3 pt-2 pb-3 border-t-2 border-[var(--nb-ink)] bg-[var(--nb-surface)]">
        <div className="max-w-2xl mx-auto space-y-2.5">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {SUGGESTIONS.map((sg, i) => (
              <button
                key={sg}
                onClick={() => send(sg)}
                disabled={busy}
                className={`${NOTE_SM} ${PRESS} ${CHIP_TINTS[i % CHIP_TINTS.length]} shrink-0 px-3 py-1.5 text-[12.5px] disabled:opacity-45 cursor-pointer ${
                  i % 2 ? "rotate-1" : "-rotate-1"
                }`}
              >
                {sg}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
              placeholder="พิมพ์ / เพื่อเลือกคำสั่ง หรือพิมพ์สั่งเอง…"
              disabled={busy}
              className={`${NOTE} flex-1 min-w-0 bg-[var(--nb-surface)] rounded-[26px] px-4 py-2.5 text-[14px] outline-none placeholder:text-[var(--nb-ink-3)] focus:shadow-[3px_3px_0_var(--nb-ink)]`}
            />
            <button
              onClick={() => send()}
              disabled={busy || !input.trim()}
              aria-label="ส่ง"
              className={`${NOTE} ${PRESS} ${N_YELLOW} grid place-items-center w-11 h-11 shrink-0 disabled:opacity-40 cursor-pointer`}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </footer>

      <button
        type="button"
        onClick={clearMemory}
        disabled={busy}
        title="ล้างความจำ AI"
        className={`${NOTE_SM} ${PRESS} ${N_PINK} absolute bottom-[112px] right-4 z-20 flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold disabled:opacity-50 -rotate-2 cursor-pointer`}
      >
        <Eraser className="w-4 h-4" /> ล้างความจำ
      </button>
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
  const [tab, setTab] = useState<TabKey>("chat");
  const [seed, setSeed] = useState<string | undefined>(undefined);

  /* ฉากโหลดดึงของจริงไว้แล้ว แท็บจึงรับไปใช้ต่อ ไม่ต้องยิงซ้ำ */
  const [steps, setSteps] = useState<SplashSteps>(SPLASH_START);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  /* การตั้งค่าเก็บไว้ที่นี่ เปิดแท็บตั้งค่าจึงเห็นค่าเดิมทันทีทุกครั้ง ไม่ต้องโหลดซ้ำ */
  const [settings, setSettings] = useState<SettingsData>({
    settings: null,
    ms: null,
    notify: null,
    health: null,
  });

  /* กันจอดับกับธีมต้องอยู่ที่นี่ ไม่ใช่ในหน้าตั้งค่า
     ตอนที่ฮุคอยู่ใน SettingsBoard พอสลับออกจากแท็บตั้งค่า คอมโพเนนต์ถูกถอด
     cleanup จึงปลดธงกันจอดับทิ้งทันที สวิตช์ขึ้นว่าเปิดแต่จอดับทุกที่นอกหน้านั้น */
  const keepAwake = useKeepAwake();
  const theme = useTheme();
  const [leaving, setLeaving] = useState(false);
  const [booted, setBooted] = useState(false);

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
          authedGet<{ rooms?: Room[]; error?: string }>("/api/rooms/status", getToken, getGraphToken),
          authedGet<SettingsData["settings"]>("/api/settings", getToken, getGraphToken).catch(
            (e) => ({ error: (e as Error).message })
          ),
          authedGet<SettingsData["ms"]>("/api/oauth/microsoft/status", getToken, getGraphToken).catch(
            (e) => ({ error: (e as Error).message })
          ),
        ]);
        if (!alive) return;
        setRooms(roomRes.rooms || []);
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

  const ask = (text: string) => {
    setSeed(text);
    setTab("chat");
  };

  return (
    <div className={`h-screen [height:100dvh] overflow-hidden ${BOARD} flex flex-col`}>
      <header className="sticky top-0 z-30 px-4 py-3 border-b-2 border-[var(--nb-ink)] bg-[var(--nb-surface)] flex items-center gap-3 shrink-0">
        <AssistantFace className="w-9 h-9" />
        <div className="flex-1 min-w-0">
          <div className="font-marker text-[16px] leading-tight">ผู้ช่วยงาน KTIS X</div>
          <div className={`font-hand text-[14px] truncate ${INK_2}`}>{account?.username}</div>
        </div>
      </header>

      {tab === "chat" && next && (
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

      {tab === "chat" && <AssistantTab seed={seed} />}
      {tab === "sched" && <ScheduleTab initial={events} initialRooms={rooms} onAsk={ask} />}
      {tab === "task" && <TasksTab />}
      {tab === "set" && (
        <SettingsBoard data={settings} onChange={setSettings} keepAwake={keepAwake} theme={theme} />
      )}

      <nav className="sticky bottom-0 z-30 grid grid-cols-4 border-t-2 border-[var(--nb-ink)] bg-[var(--nb-surface)] px-1.5 pt-2 pb-[max(0.625rem,env(safe-area-inset-bottom))] shrink-0">
        {TABS.map(({ key, label, tint, Icon }) => {
          const on = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-current={on ? "page" : undefined}
              className={`flex flex-col items-center gap-1 py-0.5 cursor-pointer ${on ? "" : INK_3}`}
            >
              <span
                className={`grid place-items-center w-11 h-[30px] rounded-[10px] border-2 transition-transform ${
                  on
                    ? `${tint} border-[var(--nb-ink)] shadow-[2px_2px_0_var(--nb-ink)] -rotate-3`
                    : "border-transparent"
                }`}
              >
                <Icon className="w-5 h-5" />
              </span>
              <span className={`text-[11px] ${on ? "font-semibold" : ""}`}>{label}</span>
            </button>
          );
        })}
      </nav>

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
