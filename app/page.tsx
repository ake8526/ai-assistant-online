"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Send, Loader2, MapPin, FileText, Folder, Settings as SettingsIcon, Eraser } from "lucide-react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { appendChatTurns, chatMemoryExpired, pruneChatHistory, type ChatTurn } from "@/lib/chatMemory";
import { SLASH_COMMANDS, isSlashMenu, matchSlashCommand, parseSlashCommand, slashToUserText } from "@/lib/slashCommands";

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

/* ---------- ดีไซน์โน้ตแปะกระดาน ----------
   สีอยู่ใน "แผ่นโน้ต" ขอบกับเงาเป็นหมึกสีเดียวกันหมด เงาแข็งไม่เบลอเหมือนกระดาษซ้อน */
const BOARD = "bg-[#f1efe9] text-[#232122] font-note";
const NOTE = "border-2 border-[#232122] rounded-[14px] shadow-[3px_3px_0_#232122]";
const NOTE_SM = "border-2 border-[#232122] rounded-[11px] shadow-[2px_2px_0_#232122]";
/* มุมพับขวาบน */
const FOLD =
  "relative rounded-tr-none before:content-[''] before:absolute before:-top-0.5 before:-right-0.5 " +
  "before:w-5 before:h-5 before:bg-[#f1efe9] before:border-l-2 before:border-b-2 " +
  "before:border-[#232122] before:rounded-bl-[5px]";
/* กดแล้วยุบลงไปทับเงา เหมือนกดกระดาษจริง */
const PRESS = "active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-transform";

const N_YELLOW = "bg-[#fef2c0]";
const N_BLUE = "bg-[#dcebfe]";
const N_GREEN = "bg-[#d6f5e3]";
const N_PINK = "bg-[#ffdee7]";
const N_PURPLE = "bg-[#eae1ff]";
const N_ORANGE = "bg-[#ffe7ce]";

/* สีโน้ตของปุ่มคำสั่งด่วน ไล่วนไปตามลำดับ */
const CHIP_TINTS = [N_BLUE, N_GREEN, N_PURPLE, N_PINK, N_ORANGE];

function MicrosoftMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true" className="shrink-0">
      <rect x="1" y="1" width="9" height="9" rx="1" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" rx="1" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" rx="1" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" rx="1" fill="#ffb900" />
    </svg>
  );
}

/* หน้ายิ้มของผู้ช่วย — วาดเส้นเดียวกับไอคอนในแอป */
function AssistantFace({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={`shrink-0 border-2 border-[#232122] rounded-[10px] ${N_YELLOW} p-0.5 -rotate-3 ${className}`}
    >
      <g fill="none" stroke="#232122" strokeWidth="2" strokeLinecap="round">
        <path d="M11.4 15 L11.4 17" />
        <path d="M20.6 14.9 L20.6 16.9" />
        <path d="M12 21.6 C14.4 24.2 18.4 24.2 20.4 21.4" />
      </g>
    </svg>
  );
}

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

function ChatContent() {
  const { account, getToken, getGraphToken } = useM365Auth();
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
    <div className={`min-h-screen ${BOARD} flex flex-col relative`}>
      <header className="px-4 py-3 border-b-2 border-[#232122] bg-white flex items-center gap-3">
        <AssistantFace className="w-9 h-9" />
        <div className="flex-1 min-w-0">
          <div className="font-marker text-[16px] leading-tight">ผู้ช่วยงาน KTIS X</div>
          <div className="font-hand text-[14px] text-[#6a6560] truncate">{account?.username}</div>
        </div>
        <Link
          href="/ai-office"
          className={`${NOTE_SM} ${PRESS} ${N_GREEN} px-2.5 py-1 font-hand text-[15px] font-bold -rotate-1`}
        >
          AI Office
        </Link>
        <Link
          href="/settings"
          aria-label="ตั้งค่า"
          className={`${NOTE_SM} ${PRESS} bg-white grid place-items-center w-9 h-9 rotate-1`}
        >
          <SettingsIcon className="w-4 h-4" />
        </Link>
      </header>

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
        className={`${NOTE_SM} ${PRESS} ${N_PINK} fixed bottom-28 right-4 z-20 flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold disabled:opacity-50 -rotate-2 cursor-pointer`}
      >
        <Eraser className="w-4 h-4" /> ล้างความจำ
      </button>
    </div>
  );
}

function HomeGate() {
  const { ready, isAuthenticated } = useM365Auth();
  if (!ready) {
    return (
      <div className={`min-h-screen ${BOARD} flex items-center justify-center`}>
        <div className={`${NOTE} ${N_YELLOW} px-5 py-3 flex items-center gap-2.5 -rotate-1`}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="font-hand text-[16px] font-bold">กำลังเปิดผู้ช่วย…</span>
        </div>
      </div>
    );
  }
  if (!isAuthenticated) return <LoginGate />;
  return <ChatContent />;
}

export default function Home() {
  return (
    <M365AuthProvider>
      <HomeGate />
    </M365AuthProvider>
  );
}
