"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Send, LogIn, Loader2, MapPin, FileText, Folder, Settings as SettingsIcon, Eraser } from "lucide-react";
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

function LoginGate() {
  const { login } = useM365Auth();
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black text-slate-100 flex flex-col items-center justify-center p-6 font-sans relative overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute top-1/4 w-96 h-96 bg-sky-500/10 rounded-full blur-3xl pointer-events-none" />
      
      <div className="max-w-md w-full text-center space-y-6 relative z-10">
        {/* Brand Capsule */}
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs font-semibold text-slate-300 backdrop-blur-md shadow-lg shadow-black/20">
          <div className="grid grid-cols-2 gap-0.5 w-3 h-3">
            <span className="bg-red-500 rounded-[0.5px]" />
            <span className="bg-emerald-500 rounded-[0.5px]" />
            <span className="bg-sky-500 rounded-[0.5px]" />
            <span className="bg-amber-400 rounded-[0.5px]" />
          </div>
          <span>KTIS GROUP · MICROSOFT 365</span>
        </div>

        {/* Mascot Center */}
        <div className="relative w-44 h-48 mx-auto flex items-center justify-center">
          <div className="absolute inset-0 bg-sky-400/20 rounded-full blur-2xl" />
          <img
            src="/ktisx-reading-video.gif?v=8"
            alt="KTIS X AI Assistant"
            className="w-full h-full object-contain relative z-10 drop-shadow-[0_12px_24px_rgba(0,0,0,0.8)]"
          />
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
            KTIS X <span className="bg-gradient-to-r from-sky-400 via-cyan-300 to-indigo-400 bg-clip-text text-transparent">AI Assistant</span>
          </h1>
          <p className="text-sm text-slate-400 leading-relaxed max-w-sm mx-auto">
            ผู้ช่วย AI อัจฉริยะองค์กร สังเกตการณ์ จัดการตารางงาน และควบคุมการประชุมอย่างแม่นยำ
          </p>
        </div>

        {/* Action Card */}
        <div className="p-4 sm:p-5 rounded-3xl bg-[#0a1230]/70 border border-sky-400/25 backdrop-blur-xl shadow-2xl shadow-black/70 space-y-3">
          <button
            onClick={() => login()}
            className="w-full flex items-center justify-between px-4 sm:px-5 py-3.5 rounded-[15px] bg-gradient-to-r from-[#005ea6] via-[#0078d4] via-[#0099e6] to-[#00c8f8] hover:from-[#006ec4] hover:via-[#0086eb] hover:to-[#22d3ee] text-white font-bold text-[14.5px] border border-white/35 shadow-[0_10px_25px_rgba(0,120,212,0.45),0_0_20px_rgba(0,242,254,0.35),inset_0_1px_2px_rgba(255,255,255,0.45)] hover:shadow-[0_15px_35px_rgba(0,120,212,0.6),0_0_30px_rgba(0,242,254,0.55)] hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] transition-all duration-200 cursor-pointer group"
          >
            <div className="flex items-center gap-3">
              <svg width="20" height="20" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                <rect x="1" y="1" width="9" height="9" fill="#f25022" rx="1.5"/>
                <rect x="11" y="1" width="9" height="9" fill="#7fba00" rx="1.5"/>
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef" rx="1.5"/>
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" rx="1.5"/>
              </svg>
              <span className="tracking-tight">เข้าสู่ระบบด้วย Microsoft 365</span>
            </div>
            <div className="w-7 h-7 rounded-full bg-white/20 border border-white/35 text-white flex items-center justify-center shadow-inner group-hover:bg-white/35 group-hover:translate-x-1 transition-all duration-200">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </div>
          </button>
          <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-400 font-medium">
            <span className="text-emerald-400">🛡️</span>
            <span>ความปลอดภัยระดับองค์กร (Microsoft Entra ID SSO)</span>
          </div>
        </div>

        <p className="text-[10px] text-slate-600 tracking-wider">KTIS ENTERPRISE INTELLIGENCE · V2.5</p>
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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans relative">
      <header className="p-4 border-b border-slate-800 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-bold">AI Assistant</div>
          <div className="text-[11px] text-slate-500 truncate">{account?.username}</div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/ai-office"
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/40 text-sky-300"
          >
            🏢 AI Office
          </Link>
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
          >
            <SettingsIcon className="w-4 h-4" /> ตั้งค่า
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4 space-y-3 max-w-2xl w-full mx-auto">
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "me" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                m.role === "me" ? "bg-emerald-600 text-white" : "bg-slate-800/90 border border-slate-700"
              }`}
            >
              {m.text}
              {m.mapUrl && (
                <a
                  href={m.mapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 flex items-center gap-1.5 text-sky-400 hover:text-sky-300 text-xs font-semibold"
                >
                  <MapPin className="w-4 h-4" /> เปิดแผนที่ / เส้นทาง
                </a>
              )}
              {!!m.files?.length && (
                <div className="mt-2 space-y-1">
                  {m.files.slice(0, 8).map((f, j) => (
                    <a
                      key={j}
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 truncate"
                    >
                      {f.is_folder ? <Folder className="w-3.5 h-3.5 shrink-0" /> : <FileText className="w-3.5 h-3.5 shrink-0" />}
                      <span className="truncate">{f.name}</span>
                    </a>
                  ))}
                </div>
              )}
              {!!m.slots?.length && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.slots.slice(0, 10).map((s, j) => (
                    <button
                      key={j}
                      onClick={() => pickSlot(s, m.intent)}
                      className="text-[11px] px-2.5 py-1.5 rounded-lg bg-sky-700/60 hover:bg-sky-600 border border-sky-600/50"
                    >
                      {m.intent === "confirm_meeting" ? `✅ ยืนยัน ${s.label}` : s.label}
                    </button>
                  ))}
                </div>
              )}
              {!!m.choices?.length && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {m.choices.slice(0, 10).map((c, j) => (
                    <button
                      key={j}
                      onClick={() => pickChoice(c, m.intent)}
                      className="text-left text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-700/70 hover:bg-slate-600 border border-slate-600"
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
          <div className="flex justify-start">
            <div className="rounded-2xl px-4 py-2.5 bg-slate-800/90 border border-slate-700">
              <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="p-3 border-t border-slate-800">
        <div className="max-w-2xl mx-auto space-y-2">
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={busy}
                className="shrink-0 text-[11px] px-2.5 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300"
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
              placeholder="พิมพ์ / เพื่อเลือกคำสั่ง หรือพิมพ์เอง…"
              disabled={busy}
              className="flex-1 rounded-xl bg-slate-900 border border-slate-700 px-4 py-2.5 text-sm outline-none focus:border-sky-600"
            />
            <button
              onClick={() => send()}
              disabled={busy || !input.trim()}
              className="px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40"
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
        className="fixed bottom-24 right-4 z-20 flex items-center gap-1.5 rounded-full bg-slate-800/95 border border-slate-600 px-3.5 py-2.5 text-xs font-semibold text-slate-100 shadow-lg shadow-black/40 hover:bg-slate-700 disabled:opacity-50"
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
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
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
