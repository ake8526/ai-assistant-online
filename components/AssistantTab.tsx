"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Send, Square, MapPin, FileText, Folder } from "lucide-react";
import { useM365Auth } from "@/components/M365AuthProvider";
import { appendChatTurns, chatMemoryExpired, pruneChatHistory, type ChatTurn } from "@/lib/chatMemory";
import { isSlashMenu, matchSlashCommand, parseSlashCommand, slashToUserText, visibleCommands } from "@/lib/slashCommands";
import { SlashMenu, useSlashMenu } from "@/components/SlashMenu";
import { bumpCommand, useCommandsByUse } from "@/lib/commandUsage";
import {
  AssistantFace,
  CHIP_TINTS,
  FOLD,
  N_BLUE,
  N_GREEN,
  N_PINK,
  N_PURPLE,
  N_YELLOW,
  NOTE,
  NOTE_SM,
  PRESS,
} from "@/components/noteStyles";
import type { ContextChip } from "@/lib/sheetContextChips";

type Slot = { start: string; end: string; label: string };
type Choice = { mail?: string; displayName?: string; period?: string; event_id?: string; label?: string; index?: number };
type FileHit = { id?: string; name?: string; url?: string; is_folder?: boolean };

type ApiResult = {
  intent: string;
  reply: string;
  slots?: Slot[];
  choices?: Choice[];
  /** ปุ่มตอบกลับที่ผู้ช่วยเสนอ เช่น "ยืนยันเพิ่มงาน" (LINE เรียกว่า quick reply) */
  suggestions?: { label: string; text: string }[];
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
  suggestions?: { label: string; text: string }[];
  files?: FileHit[];
  intent?: string;
  mapUrl?: string | null;
};

export type AssistantTabProps = {
  seed?: string;
  onSeedUsed?: () => void;
  clearSignal?: number;
  onBooked?: () => void;
  canTest?: boolean;
  /** เรียกเมื่อผู้ใช้ส่งข้อความ — ใช้เปิดโหมดโฟกัสแชทใน sheet */
  onUserSend?: () => void;
  /** chip บริบทตามแท็บ (sheet mode) */
  contextChips?: ContextChip[];
  hideContextChips?: boolean;
  welcomeText?: string;
};

export default function AssistantTab({
  seed,
  onSeedUsed,
  onBooked,
  clearSignal,
  canTest = false,
  onUserSend,
  contextChips,
  hideContextChips = false,
  welcomeText,
}: AssistantTabProps) {
  const { getToken, getGraphToken, account } = useM365Auth();
  const who = account?.username || "";
  /* สิทธิ์มาทีหลังตอนโหลดเสร็จ ระหว่างนั้นถือว่ายังไม่มี — ยอมให้คนในกลุ่มเห็นช้า
     หนึ่งจังหวะ ดีกว่าให้คนนอกกลุ่มเห็นคำสั่งทดสอบแวบหนึ่งแล้วค่อยหาย */
  const cmds = useMemo(() => visibleCommands(canTest), [canTest]);
  /** คำสั่งเรียงตามที่ผู้ใช้คนนี้ใช้บ่อย — ใช้ทำปุ่มลัดเหนือช่องพิมพ์ */
  const byUse = useCommandsByUse(who, cmds);
  const defaultWelcome =
    welcomeText ??
    "สวัสดีครับ 👋 ผมคือผู้ช่วย AI ของคุณ\nถามเรื่องนัดประชุม งานค้าง เวลาว่าง หรือสั่งนัดประชุมได้เลยครับ";
  const [msgs, setMsgs] = useState<Msg[]>([{ role: "bot", text: defaultWelcome }]);
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
  const inputRef = useRef<HTMLInputElement>(null);
  /** คำสั่งที่กำลังวิ่ง — เก็บไว้กดยกเลิกได้ บางคำถามใช้เวลาหลายสิบวินาที */
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);


  const addMsg = (m: Msg) => setMsgs((prev) => [...prev, m]);

  const fireUserSend = () => onUserSend?.();

  /** ผู้ใช้กดหยุดเอง — ไม่ใช่ error ไม่ต้องขึ้นข้อความเตือนซ้อนอีกอัน */
  const isAbort = (e: unknown) =>
    (e as Error)?.name === "AbortError" || /abort/i.test(String((e as Error)?.message || ""));

  const api = async (path: string, body: Record<string, unknown>): Promise<ApiResult> => {
    const token = await getToken();
    if (!token) throw new Error("กรุณาเข้าสู่ระบบ Microsoft 365 ก่อนครับ");
    // Graph access token (optional) — calendar then follows your M365/Outlook rights.
    // ตอน dev getGraphToken() คืนค่าปลอม ("dev-graph-token") ถ้าส่งไปด้วย ฝั่ง
    // เซิร์ฟเวอร์จะเอาไปยิง Graph แล้วได้ 401 "JWT is not well formed" ทั้งที่มี
    // token จริงเก็บไว้แล้ว — กรองแบบเดียวกับ authedGet ใน noteStyles
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const rawGraph = (await getGraphToken()) || "";
    const graphToken = rawGraph.includes(".") ? rawGraph : undefined;
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, graphToken }),
      signal: ctrl.signal,
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
      suggestions: res.suggestions,
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
          cmds.map((c, i) => `${i + 1}) /${c.cmd} — ${c.hint}`).join("\n"),
        choices: cmds.map((c) => ({ label: c.message, displayName: c.label })),
        intent: "slash_menu",
      });
      setBusy(false);
      return;
    }
    const slashBody = parseSlashCommand(t);
    if (slashBody) {
      const cmd = matchSlashCommand(slashBody, cmds);
      if (!cmd) {
        addMsg({ role: "me", text: t });
        addMsg({
          role: "bot",
          text: `ไม่รู้จักคำสั่ง /${slashBody} ครับ\nพิมพ์ / เพื่อดูรายการคำสั่ง`,
          choices: cmds.map((c) => ({ label: c.message, displayName: c.label })),
          intent: "slash_menu",
        });
        setBusy(false);
        return;
      }
      // นับก่อนแยกทาง ไม่งั้นคำสั่งที่จบในเครื่อง (ล้างความจำ/ยกเลิก) จะไม่ถูกนับ
      bumpCommand(who, cmd.cmd);
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
      // ส่วนที่พิมพ์ต่อท้ายคำสั่ง ("/test_meeting ประชุมงบ") ต้องเดินทางไปด้วย —
      // ตัดทิ้งเมื่อไหร่ /test_meeting ก็ไม่รู้ว่าจะสรุปประชุมไหน (เหมือนใน LINE)
      const slashRest = slashBody.trim().replace(/^\/?[^\s]+\s*/, "");
      t = slashToUserText(cmd, slashRest);
    }

    addMsg({ role: "me", text: original });
    fireUserSend();
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
      if (!isAbort(e)) addMsg({ role: "bot", text: `⚠️ ${(e as Error).message}` });
    }
    setBusy(false);
  };

  /* คำสั่งที่ถูกส่งมาจากแท็บอื่น — ยิงเข้าแชทครั้งเดียวต่อคำสั่ง
     ตัวกันซ้ำเคยเป็น ref ในคอมโพเนนต์นี้ ซึ่งถูกล้างทุกครั้งที่แท็บถูกถอด
     ผลคือกดล้างความจำ ออกไปแท็บอื่น แล้วกลับมา คำสั่งเดิมถูกยิงใหม่ บทสนทนา
     ที่ล้างไปจึงโผล่กลับมาทั้งชุด — ตอนนี้เปลือกแอปเป็นคนล้างคำสั่งทิ้งหลังใช้ */
  useEffect(() => {
    if (!seed) return;
    // ไม่เทียบกับค่าเดิมอีกแล้ว: เปลือกแอปล้าง seed ทิ้งทันทีที่ส่งไป ถ้ายังเทียบอยู่
    // การกดปุ่มห้องเดิมซ้ำครั้งที่สองจะเงียบไปเลยเพราะข้อความเหมือนเดิมเป๊ะ
    // (send ตั้ง state หลัง await ไม่ใช่ตรง ๆ ในตัว effect แต่กฎมองข้ามฟังก์ชันไม่เห็น)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void send(seed);
    onSeedUsed?.();
    // send เปลี่ยนทุก render โดยตั้งใจ — ผูกกับ seed อย่างเดียวพอ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  /**
   * ปุ่มเหนือช่องพิมพ์ — เปลี่ยนตามคำตอบล่าสุดเหมือน quick reply ของ LINE
   *
   * เดิมเป็นรายการคำสั่งคงที่ตายตัว ไม่ขยับตามบทสนทนาเลย ปุ่มที่ผู้ช่วยเสนอมา
   * (เช่น "ยืนยันเพิ่มงาน" หรือ "ดูตารางว่าง") จึงไม่มีที่ให้กด ต้องพิมพ์เอง
   * ถ้าคำตอบล่าสุดไม่ได้เสนอปุ่มอะไร ก็กลับไปใช้รายการคำสั่งเดิม
   */
  // ดูแค่คำตอบล่าสุด ไม่ย้อนไปเอาปุ่มของเรื่องที่จบไปแล้ว
  // รายการคำสั่งทั้งหมดไม่ต้องแย่งที่ตรงนี้แล้ว — ปุ่ม "/" ข้างช่องพิมพ์เปิดได้ตลอด
  const lastBot = msgs.filter((m) => m.role === "bot").at(-1);
  const chips = lastBot?.suggestions?.length
    ? lastBot.suggestions.slice(0, 6)
    : byUse.slice(0, 5).map((c) => ({ label: `/${c.cmd}`, text: `/${c.cmd}` }));

  const pickSlot = async (slot: Slot, intent?: string) => {
    if (busy) return;
    const ctx = ctxRef.current;
    if ((intent === "choose_slot" || intent === "confirm_meeting") && ctx.meeting) {
      setBusy(true);
      addMsg({ role: "me", text: intent === "confirm_meeting" ? `ยืนยันส่งนัด ${slot.label}` : `เลือกช่วง ${slot.label}` });
      fireUserSend();
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
        // จองสำเร็จแล้วดึงปฏิทินใหม่ทันที — แท็บตารางจะมีนัดขึ้นเอง ไม่ต้องกดซิงค์
        if (!res.error) onBooked?.();
      } catch (e) {
        if (!isAbort(e)) addMsg({ role: "bot", text: `⚠️ ${(e as Error).message}` });
      }
      setBusy(false);
    } else {
      ctx.selected = { start: slot.start, person: { mail: ctx.last_person_mail, displayName: ctx.last_person } };
      addMsg({ role: "me", text: `เลือกช่วง ${slot.label}` });
      fireUserSend();
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
        fireUserSend();
        const res = await api("/api/availability", { email: c.mail, who: c.displayName || c.mail, period: c.period || "week" });
        applyResult(res);
      } else if (intent === "choose_cancel" && c.event_id) {
        addMsg({ role: "me", text: `ยกเลิก: ${c.label}` });
        fireUserSend();
        const res = await api("/api/meetings/cancel", { event_id: c.event_id });
        addMsg({ role: "bot", text: res.error ? `⚠️ ${res.error}` : "✅ ยกเลิกนัดเรียบร้อยแล้วครับ" });
      } else if (intent === "choose_meeting" && c.event_id) {
        addMsg({ role: "me", text: `สรุป: ${c.label}` });
        fireUserSend();
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
        fireUserSend();
        addMsg({ role: "bot", text: "🔎 กำลังอ่านรายละเอียดนัด/ไฟล์แนบแล้วแนะนำให้ครับ…" });
        const res = await api("/api/command", {
          text: n ? `เตรียมนัด ${n}` : `เตรียมนัด ${c.label}`,
          context: { last_intent: "choose_prep" },
        });
        applyResult(res);
      }
    } catch (e) {
      if (!isAbort(e)) addMsg({ role: "bot", text: `⚠️ ${(e as Error).message}` });
    }
    setBusy(false);
  };

  /** หยุดคำสั่งที่กำลังรอคำตอบ — บางคำถามใช้ 20-30 วินาที ควรเลิกกลางทางได้ */
  const cancelSend = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    addMsg({ role: "bot", text: "หยุดรอคำตอบแล้วครับ — พิมพ์สั่งใหม่ได้เลย" });
  };

  /* ปุ่มล้างความจำย้ายไปอยู่บนหัวเรื่องของแอป (มุมขวา) — เปลือกแอปนับเลขขึ้น
     ทุกครั้งที่กด แท็บแชทที่ถือบทสนทนาอยู่จึงเป็นคนล้างเอง */
  const clearedRef = useRef(clearSignal || 0);
  useEffect(() => {
    if (clearSignal === undefined || clearSignal === clearedRef.current) return;
    clearedRef.current = clearSignal;
    clearMemory();
    // clearMemory ประกาศไว้ล่างกว่านี้ ผูกกับสัญญาณอย่างเดียวพอ
  }, [clearSignal]);

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

  const slash = useSlashMenu({
    commands: cmds,
    input,
    setInput,
    send,
    focusInput: () => inputRef.current?.focus(),
  });

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
          {!hideContextChips && !!contextChips?.length && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {contextChips.map((c, i) => (
                <button
                  key={`ctx-${c.text}-${i}`}
                  onClick={() => send(c.text)}
                  disabled={busy}
                  className={`${NOTE_SM} ${PRESS} ${N_GREEN} shrink-0 px-3 py-1.5 text-[12.5px] disabled:opacity-45 cursor-pointer ${
                    i % 2 ? "rotate-1" : "-rotate-1"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          <div data-tour="chat-chips" className="flex gap-2 overflow-x-auto pb-1">
            {chips.map((c, i) => (
              <button
                key={`${c.text}-${i}`}
                onClick={() => send(c.text)}
                disabled={busy}
                className={`${NOTE_SM} ${PRESS} ${
                  /^ยืนยัน/.test(c.label) ? N_GREEN : CHIP_TINTS[i % CHIP_TINTS.length]
                } shrink-0 px-3 py-1.5 text-[12.5px] disabled:opacity-45 cursor-pointer ${
                  i % 2 ? "rotate-1" : "-rotate-1"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="relative flex gap-2 items-center">
            {slash.open && !busy && (
              <SlashMenu
                items={slash.items}
                index={slash.index}
                query={slash.query}
                onPick={slash.pick}
                onHover={slash.setIndex}
              />
            )}
            {/* บนมือถือกด / บนคีย์บอร์ดลำบาก ปุ่มนี้เปิดเมนูเดียวกันด้วยนิ้ว
                ป้ายเป็น "?" เพราะคนที่ยังไม่รู้ว่ามีคำสั่งอะไร อ่าน "/" ไม่ออกว่าคืออะไร */}
            <button
              onClick={slash.toggle}
              // อย่าให้ช่องพิมพ์หลุดโฟกัส ไม่งั้น blur ปิดเมนูแล้วปุ่มนี้ไปเปิดใหม่ทันที
              onMouseDown={(e) => e.preventDefault()}
              disabled={busy}
              aria-label="ดูคำสั่งทั้งหมด"
              aria-expanded={slash.open}
              data-tour="chat-ask"
              className={`${NOTE} ${PRESS} ${
                slash.open ? N_GREEN : N_PURPLE
              } font-marker grid place-items-center w-11 h-11 shrink-0 text-[18px] leading-none disabled:opacity-40 cursor-pointer`}
            >
              ?
            </button>
            <input
              data-tour="chat-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={slash.onKeyDown}
              onBlur={slash.close}
              placeholder="พิมพ์ / เพื่อเลือกคำสั่ง หรือพิมพ์สั่งเอง…"
              disabled={busy}
              className={`${NOTE} flex-1 min-w-0 bg-[var(--nb-surface)] rounded-[26px] px-4 py-2.5 text-[14px] outline-none placeholder:text-[var(--nb-ink-3)] focus:shadow-[3px_3px_0_var(--nb-ink)]`}
            />
            {busy ? (
              /* คำสั่งบางอย่างใช้เวลาหลายสิบวินาที (ค้นปฏิทินหลายคน/เรียก AI)
                 ระหว่างนั้นต้องกดยกเลิกได้ ไม่ใช่รอเฉย ๆ อย่างเดียว */
              <button
                onClick={cancelSend}
                aria-label="ยกเลิกคำสั่ง"
                className={`${NOTE} ${PRESS} ${N_PINK} grid place-items-center w-11 h-11 shrink-0 cursor-pointer`}
              >
                <Square className="w-3.5 h-3.5" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => send()}
                disabled={!input.trim()}
                aria-label="ส่ง"
                className={`${NOTE} ${PRESS} ${N_YELLOW} grid place-items-center w-11 h-11 shrink-0 disabled:opacity-40 cursor-pointer`}
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </footer>


    </div>
  );
}
