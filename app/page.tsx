"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Send,
  Loader2,
  MapPin,
  FileText,
  Folder,
  Eraser,
  MessageSquare,
  CalendarDays,
  DoorOpen,
  SlidersHorizontal,
  ArrowRight,
} from "lucide-react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { appendChatTurns, chatMemoryExpired, pruneChatHistory, type ChatTurn } from "@/lib/chatMemory";
import { SLASH_COMMANDS, isSlashMenu, matchSlashCommand, parseSlashCommand, slashToUserText } from "@/lib/slashCommands";
import CalendarTab from "@/components/CalendarTab";
import RoomsTab from "@/components/RoomsTab";
import SettingsTab from "@/components/SettingsTab";
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
    <div className={`min-h-screen ${BOARD} flex flex-col items-center justify-center p-6`}>
      <div className="w-full max-w-sm flex flex-col items-center gap-5">
        <div className={`${NOTE_SM} ${N_BLUE} px-3 py-0.5 -rotate-2 font-hand text-[15px] font-bold`}>
          KTIS Group · Microsoft 365
        </div>

        <div className={`${NOTE} ${FOLD} bg-white w-full p-6 pt-7 flex flex-col items-center gap-3 -rotate-[0.6deg]`}>
          <img
            src="/ktisx-reading-video.gif?v=8"
            alt="ผู้ช่วย KTIS X"
            className="w-32 h-36 object-contain"
          />
          <h1 className="font-marker text-[21px] leading-snug text-center">KTIS X ผู้ช่วยงาน</h1>
          <p className="text-[13.5px] text-[#6a6560] text-center leading-relaxed">
            ถามตารางงาน เช็คเวลาว่าง จองห้องประชุม สรุปวาระ — พิมพ์สั่งเป็นภาษาคนได้เลยครับ
          </p>
        </div>

        <button
          onClick={() => login()}
          className={`${NOTE} ${PRESS} ${N_YELLOW} w-full px-5 py-4 flex items-center gap-3 rotate-[0.5deg] cursor-pointer`}
        >
          <MicrosoftMark />
          <span className="flex-1 text-left font-semibold text-[14.5px]">เข้าสู่ระบบด้วย Microsoft 365</span>
          <span className="grid place-items-center w-7 h-7 border-2 border-[#232122] rounded-full text-[15px] leading-none">
            →
          </span>
        </button>

        <p className="font-hand text-[15px] text-[#9c968e] -rotate-1 text-center">
          ใช้บัญชี KTIS ของคุณ · ปลอดภัยด้วย Microsoft Entra ID SSO
        </p>
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
      <main className="flex-1 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "me" ? "justify-end" : "justify-start gap-2 items-end"}`}>
            {m.role === "bot" && <AssistantFace className="w-8 h-8" />}
            <div
              className={`${NOTE} max-w-[82%] px-4 py-3 text-[14px] whitespace-pre-wrap leading-relaxed ${
                m.role === "me" ? `${N_YELLOW} rotate-[0.4deg]` : `bg-white ${FOLD} -rotate-[0.4deg]`
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
            <div className={`${NOTE} bg-white px-4 py-3.5 flex gap-1.5`}>
              <i className="w-[7px] h-[7px] rounded-full bg-[#232122] animate-bounce [animation-delay:0ms]" />
              <i className="w-[7px] h-[7px] rounded-full bg-[#232122] animate-bounce [animation-delay:150ms]" />
              <i className="w-[7px] h-[7px] rounded-full bg-[#232122] animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="px-3 pt-2 pb-3 border-t-2 border-[#232122] bg-white">
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
              className={`${NOTE} flex-1 min-w-0 bg-white rounded-[26px] px-4 py-2.5 text-[14px] outline-none placeholder:text-[#9c968e] focus:shadow-[3px_3px_0_#232122]`}
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

const INTRO_KEY = "ktisx_intro_seen";

const INTRO_SLIDES = [
  {
    tint: N_BLUE,
    title: "สั่งงานเป็นภาษาคน",
    body: "พิมพ์อย่างที่คุยกับเลขา — “พฤหัสว่างไหม”, “จองห้องบ่ายสอง”, “สรุปวาระประชุมเช้า” ไม่ต้องจำคำสั่ง",
  },
  {
    tint: N_GREEN,
    title: "ตารางจริงจาก Microsoft 365",
    body: "ปฏิทิน เวลาว่าง และสถานะห้องประชุม อ่านจาก Outlook ของคุณโดยตรง เห็นเท่าที่สิทธิ์คุณเห็น",
  },
  {
    tint: N_ORANGE,
    title: "ทำงานต่อได้ทุกที่",
    body: "สั่งจากแอป จากเว็บ หรือจาก LINE ก็เรื่องเดียวกัน ผู้ช่วยจำบริบทที่คุยไว้ให้",
  },
];

function IntroGate({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const last = i === INTRO_SLIDES.length - 1;
  const slide = INTRO_SLIDES[i];

  return (
    <div className={`min-h-screen ${BOARD} flex flex-col items-center justify-center p-6`}>
      <div className="w-full max-w-sm flex flex-col items-center gap-5">
        <div className={`${NOTE_SM} ${N_PURPLE} px-3 py-0.5 -rotate-2 font-hand text-[15px] font-bold`}>
          KTIS X ผู้ช่วยงาน
        </div>

        <div className={`${NOTE} ${FOLD} ${slide.tint} w-full p-6 pt-7 flex flex-col items-center gap-3 -rotate-[0.6deg]`}>
          <AssistantFace className="w-16 h-16" />
          <h1 className="font-marker text-[20px] leading-snug text-center">{slide.title}</h1>
          <p className={`text-[13.5px] ${INK_2} text-center leading-relaxed`}>{slide.body}</p>
        </div>

        <div className="flex items-center gap-2" role="tablist" aria-label="หน้าแนะนำ">
          {INTRO_SLIDES.map((_, j) => (
            <button
              key={j}
              onClick={() => setI(j)}
              aria-label={`หน้าที่ ${j + 1}`}
              aria-selected={j === i}
              role="tab"
              className={`border-2 border-[#232122] cursor-pointer ${
                j === i ? "w-6 h-3 rounded-[5px] bg-[#232122]" : "w-3 h-3 rounded-full bg-white"
              }`}
            />
          ))}
        </div>

        <button
          onClick={() => (last ? onDone() : setI(i + 1))}
          className={`${NOTE} ${PRESS} ${N_YELLOW} w-full px-5 py-3.5 flex items-center justify-center gap-2 font-semibold text-[14.5px] rotate-[0.5deg] cursor-pointer`}
        >
          {last ? "เริ่มใช้งาน" : "ถัดไป"} <ArrowRight className="w-4 h-4" />
        </button>

        <button
          onClick={onDone}
          className={`font-hand text-[16px] ${INK_3} underline decoration-wavy underline-offset-4 cursor-pointer`}
        >
          ข้ามไปเลย
        </button>
      </div>
    </div>
  );
}

type TabKey = "chat" | "cal" | "room" | "set";

const TABS: { key: TabKey; label: string; tint: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "chat", label: "ผู้ช่วย AI", tint: N_BLUE, Icon: MessageSquare },
  { key: "cal", label: "ปฏิทินงาน", tint: N_PURPLE, Icon: CalendarDays },
  { key: "room", label: "ห้องประชุม", tint: N_GREEN, Icon: DoorOpen },
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
  const [next, setNext] = useState<NextUp>(null);

  /* นัดถัดไปของวันนี้ — โน้ตใบบนสุดของแท็บผู้ช่วย */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await authedGet<{ events?: NextUp[] }>(
          "/api/calendar/events",
          getToken,
          getGraphToken
        );
        if (!alive) return;
        // นับนัดที่ยังไม่จบว่ายังน่าสนใจ — ที่กำลังประชุมอยู่ต้องมาก่อนนัดพรุ่งนี้
        const now = new Date();
        const upcoming = (res.events || [])
          .filter((e): e is NonNullable<NextUp> => {
            const end = e && wallDate(e.end);
            return !!end && end > now;
          })
          .sort((a, b) => a.start.localeCompare(b.start));
        setNext(upcoming[0] || null);
      } catch {
        /* ไม่มีนัดถัดไปก็ไม่ต้องขึ้นโน้ต */
      }
    })();
    return () => {
      alive = false;
    };
  }, [getToken, getGraphToken]);

  const ask = (text: string) => {
    setSeed(text);
    setTab("chat");
  };

  return (
    <div className={`min-h-screen ${BOARD} flex flex-col`}>
      <header className="px-4 py-3 border-b-2 border-[#232122] bg-white flex items-center gap-3 shrink-0">
        <AssistantFace className="w-9 h-9" />
        <div className="flex-1 min-w-0">
          <div className="font-marker text-[16px] leading-tight">ผู้ช่วยงาน KTIS X</div>
          <div className={`font-hand text-[14px] truncate ${INK_2}`}>{account?.username}</div>
        </div>
      </header>

      {tab === "chat" && next && (
        <button
          onClick={() => setTab("cal")}
          className={`${NOTE} ${FOLD} ${N_BLUE} ${PRESS} mx-4 mt-4 px-4 py-3 flex items-center gap-3 text-left -rotate-[0.6deg] cursor-pointer`}
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
      {tab === "cal" && <CalendarTab />}
      {tab === "room" && <RoomsTab onAsk={ask} />}
      {tab === "set" && <SettingsTab />}

      <nav className="grid grid-cols-4 border-t-2 border-[#232122] bg-white px-1.5 pt-2 pb-2.5 shrink-0">
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
                    ? `${tint} border-[#232122] shadow-[2px_2px_0_#232122] -rotate-3`
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
    </div>
  );
}

function HomeGate() {
  const { ready, isAuthenticated } = useM365Auth();
  const [introDone, setIntroDone] = useState<boolean | null>(null);

  // localStorage อ่านได้แค่บนเบราว์เซอร์ จะอ่านตอน render ไม่ได้เพราะ SSR จะได้ค่าคนละอย่าง
  // แล้ว hydrate ไม่ตรงกัน — set ครั้งเดียวตอน mount คือทางที่ถูกต้องของเคสนี้
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIntroDone(localStorage.getItem(INTRO_KEY) === "1");
    } catch {
      setIntroDone(true);
    }
  }, []);

  if (!ready || introDone === null) {
    return (
      <div className={`min-h-screen ${BOARD} flex items-center justify-center`}>
        <div className={`${NOTE} ${N_YELLOW} px-5 py-3 flex items-center gap-2.5 -rotate-1`}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="font-hand text-[16px] font-bold">กำลังเปิดผู้ช่วย…</span>
        </div>
      </div>
    );
  }

  if (!introDone) {
    return (
      <IntroGate
        onDone={() => {
          try {
            localStorage.setItem(INTRO_KEY, "1");
          } catch {
            /* โหมดส่วนตัวเขียนไม่ได้ ก็แค่เห็น intro ใหม่รอบหน้า */
          }
          setIntroDone(true);
        }}
      />
    );
  }

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
