"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Send, LogIn, Loader2, MapPin, FileText, Folder, Settings as SettingsIcon, Eraser } from "lucide-react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { appendChatTurns, chatMemoryExpired, pruneChatHistory, type ChatTurn } from "@/lib/chatMemory";

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
  "วันนี้มีนัดอะไรบ้าง",
  "งานค้างมีอะไรบ้าง",
  "ช่วงไหนว่างบ้าง",
  "สรุปประชุมที่ผ่านมา",
  "ล้างความจำ",
];

function LoginGate() {
  const { login } = useM365Auth();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-sans">
      <div className="max-w-sm w-full text-center space-y-5">
        <div className="text-3xl font-bold tracking-tight">AI Assistant</div>
        <p className="text-sm text-slate-400 leading-relaxed">
          เข้าสู่ระบบด้วยบัญชี Microsoft 365 ขององค์กรก่อนใช้งานแชทสั่งงาน
        </p>
        <button
          onClick={() => login()}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl bg-sky-600 hover:bg-sky-500 font-semibold text-sm transition"
        >
          <LogIn className="w-5 h-5" />
          เข้าสู่ระบบ Microsoft 365
        </button>
        <p className="text-[11px] text-slate-600">SSO องค์กร · ข้อมูลถูกใช้เฉพาะที่คุณอนุญาต</p>
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
    const t = (text ?? input).trim();
    if (!t || busy) return;
    setInput("");
    setBusy(true);
    addMsg({ role: "me", text: t });
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
    if (intent === "choose_slot" && ctx.meeting) {
      setBusy(true);
      addMsg({ role: "me", text: `เลือกช่วง ${slot.label}` });
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
            : `✅ จองประชุมแล้ว!\n📌 ${ctx.meeting.subject}\n🕐 ${slot.label}`,
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
    setMsgs([{ role: "bot", text: "ล้างความจำการสนทนาแล้วครับ — เริ่มเรื่องใหม่ได้เลย 🧹" }]);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <header className="p-4 border-b border-slate-800 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-bold">AI Assistant</div>
          <div className="text-[11px] text-slate-500 truncate">{account?.username}</div>
        </div>
        <button
          type="button"
          onClick={clearMemory}
          disabled={busy}
          title="ล้างความจำ AI"
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 disabled:opacity-50"
        >
          <Eraser className="w-4 h-4" /> ล้างความจำ
        </button>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
        >
          <SettingsIcon className="w-4 h-4" /> ตั้งค่า
        </Link>
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
                      {s.label}
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
              placeholder="พิมพ์คำสั่ง เช่น วันนี้มีนัดอะไร…"
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
