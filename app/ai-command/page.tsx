"use client";

/**
 * AI Command Studio — the mobile design from the /ai-office-mobile.html mock,
 * wired to the real assistant. /ai-command
 *
 * Looks like /ai-office-v2 (near-black, glass bar, rounded-2xl cards on white/10
 * hairlines, per-department gradient, mono department codes, four execution
 * steps). Behaves like LINE:
 *
 * - Every command goes to POST /api/command — the same endpoint the web chat
 *   uses and the same brain the LINE webhook calls. The answer shown is the
 *   assistant's own reply text, line breaks intact, not a re-formatted summary.
 * - The quick replies under an answer are the `suggestions` the API returned,
 *   so they are the same follow-ups LINE offers.
 * - The four steps track the real request (สั่ง → ขอสิทธิ์ → ส่งให้ผู้ช่วย →
 *   ตอบกลับ). No setTimeout theatre.
 * - The five departments are shortcut sets, nothing more. The backend has no
 *   departments; the same command gives the same answer whichever card is
 *   selected, and the panel says so rather than implying a router.
 * - Signed out, the API refuses and the card says so. Nothing is invented.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { RICH_MENU_TILES } from "@/lib/lineMenuTiles";

type Dept = {
  id: string;
  short: string;
  name: string;
  code: string;
  icon: string;
  grad: string;
  tint: string;
  ring: string;
  accent: string;
  role: string;
  /** Real commands only — every one of these is answered by lib/commands.ts. */
  cmds: string[];
};

const DEPTS: Dept[] = [
  {
    id: "executive",
    short: "บริหาร & เลขา",
    name: "ฝ่ายบริหาร & เลขา AI",
    code: "Executive AI",
    icon: "💼",
    grad: "linear-gradient(90deg,#34d399,#2dd4bf,#22d3ee)",
    tint: "rgba(16,185,129,0.12)",
    ring: "rgba(16,185,129,0.45)",
    accent: "#34d399",
    role: "ปฏิทิน Outlook · นัดประชุม · งานที่ต้องติดตาม",
    cmds: ["ตารางวันนี้", "นัดพรุ่งนี้", "ว่างกี่โมงพรุ่งนี้", "ดูงานที่ต้องติดตาม", "นัดประชุม"],
  },
  {
    id: "people",
    short: "คน & ติดต่อ",
    name: "ค้นคน & ตารางคนอื่น",
    code: "People & Contacts",
    icon: "👥",
    grad: "linear-gradient(90deg,#c084fc,#f472b6,#fb7185)",
    tint: "rgba(168,85,247,0.12)",
    ring: "rgba(168,85,247,0.45)",
    accent: "#c084fc",
    role: "ดูตารางคนอื่นเท่าที่ Outlook เขาเปิดให้ · หาเบอร์/ตำแหน่งจากไดเรกทอรี",
    cmds: ["ดูตารางเบสพรุ่งนี้", "ขอเบอร์เบส", "ขอตำแหน่งเบส", "ชื่อเล่นซ้ำกี่คน"],
  },
  {
    id: "news",
    short: "ข่าวสาร & PR",
    name: "ข่าว & บรีฟเช้า",
    code: "News & Digest",
    icon: "📰",
    grad: "linear-gradient(90deg,#38bdf8,#3b82f6,#6366f1)",
    tint: "rgba(56,189,248,0.12)",
    ring: "rgba(56,189,248,0.45)",
    accent: "#38bdf8",
    role: "ข่าวจาก RSS / Facebook / YouTube ที่คุณติดตามไว้",
    cmds: ["ข่าววันนี้", "ดูแหล่งข่าว", "/ตั้งค่าข่าว"],
  },
  {
    id: "files",
    short: "ไฟล์ & เอกสาร",
    name: "ไฟล์ใน OneDrive",
    code: "Files & Docs",
    icon: "📂",
    grad: "linear-gradient(90deg,#fbbf24,#fb923c,#facc15)",
    tint: "rgba(251,191,36,0.12)",
    ring: "rgba(251,191,36,0.45)",
    accent: "#fbbf24",
    role: "ค้น อ่าน สรุป และผูกไฟล์เข้ากับนัดประชุม",
    cmds: ["หาไฟล์ งบ Q3", "สรุปอัน 1", "ผูกไฟล์นัด 1", "เอกสารนัด 1"],
  },
  {
    id: "system",
    short: "ระบบ & คำสั่ง",
    name: "คำสั่งระบบ",
    code: "System",
    icon: "🛡️",
    grad: "linear-gradient(90deg,#818cf8,#a855f7,#f472b6)",
    tint: "rgba(129,140,248,0.12)",
    ring: "rgba(129,140,248,0.45)",
    accent: "#818cf8",
    role: "คู่มือคำสั่ง · ล้างความจำการสนทนา · ยกเลิกสิ่งที่ค้าง",
    cmds: ["/ช่วยเหลือ", "สรุปประชุม", "/ล้างความจำ", "/ยกเลิก"],
  },
];

const STEPS: [string, string][] = [
  ["1. รับคำสั่ง", "Receive"],
  ["2. ขอสิทธิ์", "Auth"],
  ["3. ส่งให้ผู้ช่วย", "Reasoning"],
  ["4. ตอบกลับ", "Done"],
];

type Turn = {
  id: number;
  prompt: string;
  at: string;
  /** 1–4, mirroring STEPS; 4 means the request is finished either way. */
  step: number;
  reply: string | null;
  intent?: string;
  ms?: number;
  suggestions?: { label: string; text: string }[];
  error?: string;
  needsLogin?: boolean;
};

const monoFont = "font-[family-name:var(--font-studio-mono)]";

/**
 * Replies are written once for both channels and some carry **bold** markers.
 * LINE strips them in plainForLine() (app/api/line/webhook/route.ts); do the
 * same here, or the asterisks show up raw and the answer stops looking like
 * the one people get in chat.
 */
function plainText(s: string): string {
  return (s || "").replace(/\*\*([\s\S]+?)\*\*/g, "$1");
}

export default function AICommandPage() {
  // The hook must be read by a child of the provider, never by the component
  // that renders it — that mistake is why /ai-office answers from canned text.
  return (
    <M365AuthProvider>
      <Studio />
    </M365AuthProvider>
  );
}

function Studio() {
  const { account, isAuthenticated, ready, login, getToken, getGraphToken } = useM365Auth();
  const [activeId, setActiveId] = useState(DEPTS[0].id);
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);

  const dept = useMemo(() => DEPTS.find((d) => d.id === activeId) ?? DEPTS[0], [activeId]);
  const last = turns[turns.length - 1];
  const step = last && busy ? last.step : last ? 4 : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheet(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A mouse has no sideways gesture; forward the wheel to the card strip.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      strip.scrollBy({ left: d, behavior: "auto" });
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  };

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || busy) return;
      const id = nextId.current++;
      const started = Date.now();
      const at = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
      setTurns((prev) => [...prev, { id, prompt: clean, at, step: 1, reply: null }]);
      setDraft("");
      grow(inputRef.current);
      setBusy(true);

      const patch = (p: Partial<Turn>) =>
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)));

      try {
        const token = await getToken();
        const graphToken = (await getGraphToken()) || undefined;
        patch({ step: 2 });

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        patch({ step: 3 });

        const res = await fetch("/api/command", {
          method: "POST",
          headers,
          body: JSON.stringify({ text: clean, graphToken }),
        });
        const data = (await res.json()) as {
          reply?: string;
          intent?: string;
          suggestions?: { label: string; text: string }[];
          error?: string;
        };

        if (res.status === 401) {
          patch({
            step: 4,
            error: "ต้องเข้าสู่ระบบ Microsoft 365 ก่อน — คำสั่งนี้ยังไม่ถูกประมวลผล",
            needsLogin: true,
            ms: Date.now() - started,
          });
        } else if (data.reply) {
          patch({
            step: 4,
            reply: data.reply,
            intent: data.intent,
            suggestions: data.suggestions,
            ms: Date.now() - started,
          });
        } else {
          patch({ step: 4, error: data.error || "ระบบไม่ได้ส่งคำตอบกลับมา", ms: Date.now() - started });
        }
      } catch (e) {
        patch({ step: 4, error: `เรียก /api/command ไม่สำเร็จ — ${String(e).slice(0, 140)}`, ms: Date.now() - started });
      } finally {
        setBusy(false);
      }
    },
    [busy, getGraphToken, getToken]
  );

  // Keep the newest answer in view; plain assignment, since smooth scrolling
  // does not run while the tab is in the background.
  useEffect(() => {
    const b = bodyRef.current;
    if (b) b.scrollTop = b.scrollHeight;
  }, [turns]);

  const copy = async (t: Turn) => {
    if (!t.reply) return;
    try {
      await navigator.clipboard.writeText(plainText(t.reply));
      setCopied(t.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — stay quiet rather than claim success */
    }
  };

  return (
    <div
      style={{ colorScheme: "dark", fontFamily: "var(--font-thai), system-ui, sans-serif" }}
      className="mx-auto grid h-dvh w-full max-w-[520px] grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-[#0a0a0a] text-[#e8ecf4] shadow-[0_0_0_1px_rgba(255,255,255,0.06)] sm:max-w-[480px]"
    >
      {/* ------------------------------------------------------------ app bar */}
      <header className="flex items-center gap-2.5 border-b border-white/10 bg-[#070d1f]/90 px-3.5 py-2.5 backdrop-blur-xl">
        <span className="h-8 w-8 shrink-0 rounded-xl bg-gradient-to-tr from-sky-400 via-indigo-500 to-purple-500 p-0.5">
          <span className={`grid h-full w-full place-items-center rounded-[9px] bg-[#0a0a0a] text-[13px] text-sky-300 ${monoFont}`}>
            &gt;_
          </span>
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14.5px] font-bold tracking-tight">AI Command Studio</span>
          <span className={`block text-[8.5px] tracking-[0.18em] text-sky-300 uppercase ${monoFont}`}>
            {isAuthenticated ? account?.username : "ยังไม่ได้เข้าสู่ระบบ"}
          </span>
        </span>

        {ready && !isAuthenticated ? (
          <button
            onClick={() => void login()}
            className="ml-auto shrink-0 rounded-full border border-emerald-400/40 bg-slate-950/80 px-3 py-1.5 text-[10px] font-semibold text-emerald-300 transition hover:border-emerald-400"
          >
            เข้าสู่ระบบ M365
          </button>
        ) : (
          <span className={`ml-auto shrink-0 rounded-full border border-emerald-400/30 bg-slate-950/80 px-2 py-1 text-[8.5px] tracking-[0.08em] text-emerald-300 ${monoFont}`}>
            LLM CHAIN ACTIVE
          </span>
        )}
        <Link
          href="/"
          className="shrink-0 rounded-lg px-1.5 py-1 text-[11px] text-slate-400 transition hover:text-slate-100"
        >
          แชท
        </Link>
      </header>

      {/* ------------------------------------------------------ department row */}
      <div className="relative border-b border-white/5 pr-[46px]">
        <div
          ref={stripRef}
          className="flex snap-x snap-proximity gap-2 overflow-x-auto py-2.5 pl-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {DEPTS.map((d) => {
            const on = d.id === dept.id;
            return (
              <button
                key={d.id}
                onClick={() => setActiveId(d.id)}
                aria-current={on ? "true" : undefined}
                style={
                  on
                    ? { borderColor: d.ring, boxShadow: `inset 0 0 0 1px ${d.ring}, 0 0 18px -8px ${d.accent}` }
                    : undefined
                }
                className={`relative flex w-[182px] shrink-0 snap-start items-center gap-2.5 overflow-hidden rounded-2xl border border-white/10 p-2.5 text-left transition ${
                  on ? "bg-slate-900/95" : "bg-slate-900/40 hover:bg-slate-900/70"
                }`}
              >
                {on && <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: d.grad }} />}
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border text-[15px]"
                  style={{ background: d.tint, borderColor: d.ring }}
                >
                  {d.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-bold text-slate-100">{d.short}</span>
                  <span className={`block truncate text-[8.5px] tracking-[0.13em] text-slate-500 uppercase ${monoFont}`}>
                    {d.code}
                  </span>
                </span>
                {on && <span className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />}
              </button>
            );
          })}
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-[46px] w-8 bg-gradient-to-r from-transparent to-[#0a0a0a]" />
        <button
          onClick={() => setSheet(true)}
          aria-label="ดูทุกหมวด"
          className={`absolute top-1/2 right-2.5 h-8 w-8 -translate-y-1/2 rounded-xl border border-white/10 bg-slate-950/90 text-[13px] text-sky-300 transition hover:border-sky-400/60 ${monoFont}`}
        >
          ⋮⋮
        </button>
      </div>

      {/* --------------------------------------------------------------- body */}
      <div ref={bodyRef} className="flex min-w-0 flex-col gap-3 overflow-y-auto p-3.5 [&>*]:shrink-0">
        {/* department panel */}
        <section className="rounded-[22px] border border-white/10 bg-slate-900/80 p-3.5">
          <div className="flex items-center gap-2.5 border-b border-white/10 pb-2.5">
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[13px] border text-[17px]"
              style={{ background: dept.tint, borderColor: dept.ring }}
            >
              {dept.icon}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-[13.5px] font-bold text-white">{dept.name}</h1>
              <p className="text-[10.5px] leading-snug text-slate-400">{dept.role}</p>
            </div>
            <span
              className="shrink-0 rounded-full border px-2 py-0.5 text-[9px]"
              style={{ color: dept.accent, borderColor: dept.ring, background: dept.tint }}
            >
              ● Online
            </span>
          </div>

          <p className="mt-2.5 mb-1.5 flex items-center gap-1.5 text-[10.5px] font-bold text-slate-300">
            ⚡ คำสั่งด่วน
          </p>
          {dept.cmds.map((c) => (
            <button
              key={c}
              onClick={() => void send(c)}
              disabled={busy}
              className="mb-1.5 flex w-full items-center justify-between gap-2 rounded-[13px] border border-white/5 bg-slate-950/80 px-3 py-2.5 text-left text-[12px] font-semibold text-slate-200 transition hover:bg-slate-800/90 disabled:opacity-40"
            >
              <span className="truncate">{c}</span>
              <span className={`shrink-0 text-slate-500 ${monoFont}`}>›</span>
            </button>
          ))}
          <p className="mt-1 text-[9.5px] leading-relaxed text-slate-500">
            หมวดเป็นแค่ชุดคำสั่งลัด — ระบบหลังบ้านไม่ได้แยกฝ่าย พิมพ์คำสั่งไหนก็ได้ผลเหมือนกันทุกหมวด
          </p>
        </section>

        {/* execution steps — driven by the real request */}
        <section className="rounded-[22px] border border-white/10 bg-slate-900/80 p-3.5">
          <p className="mb-2 text-[10.5px] font-bold text-slate-300">🤖 ขั้นตอนประมวลผล (Execution Steps)</p>
          <div className="grid grid-cols-4 gap-1.5">
            {STEPS.map(([th, en], i) => {
              const done = step > i;
              const now = step === i + 1 && busy;
              return (
                <div
                  key={en}
                  className={`rounded-[13px] border px-1 py-1.5 text-center transition ${
                    done ? "border-sky-400/45 bg-sky-400/10" : "border-white/5 bg-slate-950/70"
                  } ${now ? "animate-pulse" : ""}`}
                >
                  <span className={`block text-[10px] font-bold ${done ? "text-sky-200" : "text-slate-500"}`}>{th}</span>
                  <span className={`block text-[8px] text-slate-600 ${monoFont}`}>{en}</span>
                </div>
              );
            })}
          </div>
        </section>

        {ready && !isAuthenticated && turns.length === 0 && (
          <p className="flex gap-2 rounded-[14px] border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200">
            <span>⚠</span>
            <span>
              ยังไม่ได้เข้าสู่ระบบ — คำสั่งจะถูก API ปฏิเสธ หน้านี้ไม่มีคำตอบสำเร็จรูปให้ดู
              กดปุ่มเข้าสู่ระบบด้านบนก่อนครับ
            </span>
          </p>
        )}

        {/* Nothing sent yet: say so in the free space, rather than leaving a
            third of the screen blank and looking half-loaded. */}
        {turns.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
            <p className={`text-[10px] tracking-[0.18em] text-slate-600 uppercase ${monoFont}`}>
              awaiting command
            </p>
            <p className="text-[12.5px] leading-relaxed text-slate-500">
              แตะคำสั่งด่วนด้านบน หรือพิมพ์คำสั่งไทยธรรมดาด้านล่างได้เลย
              <br />
              คำตอบมาจากผู้ช่วยตัวเดียวกับที่ตอบใน LINE
            </p>
          </div>
        )}

        {/* transcript */}
        {turns.map((t) => (
          <article key={t.id} className="flex flex-col gap-1.5">
            <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 px-0.5 text-[10.5px] text-slate-500 ${monoFont}`}>
              <span className="text-emerald-400">›</span>
              <span className="font-medium text-slate-200">{t.prompt}</span>
              <span>{t.at}</span>
              {t.reply === null && !t.error && <span className="text-sky-300">กำลังประมวลผล…</span>}
            </div>

            {t.error ? (
              <div className="relative overflow-hidden rounded-[22px] border border-white/10 bg-slate-900/80 p-3.5">
                <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-500 to-amber-300" />
                <span className={`inline-block rounded-full border border-white/10 bg-slate-950/90 px-2.5 py-0.5 text-[9.5px] font-bold text-amber-300 ${monoFont}`}>
                  {t.needsLogin ? "unauthorized" : "error"}
                </span>
                <p className="mt-2 text-[13px] leading-relaxed text-amber-200">{t.error}</p>
                {t.needsLogin && (
                  <button
                    onClick={() => void login()}
                    className="mt-2.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-500"
                  >
                    เข้าสู่ระบบแล้วสั่งอีกครั้ง
                  </button>
                )}
              </div>
            ) : t.reply === null ? (
              <div className="flex flex-col gap-2 rounded-[22px] border border-white/10 bg-slate-900/60 p-3.5">
                <span className="h-3 w-3/5 animate-pulse rounded bg-slate-800" />
                <span className="h-3 w-2/5 animate-pulse rounded bg-slate-800" />
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-[22px] border border-white/10 bg-slate-900/80 p-3.5">
                <span className="absolute inset-x-0 top-0 h-1" style={{ background: dept.grad }} />
                <span
                  className={`inline-block rounded-full border border-white/10 bg-slate-950/90 px-2.5 py-0.5 text-[9.5px] font-bold ${monoFont}`}
                  style={{ color: dept.accent }}
                >
                  {t.intent || "reply"}
                  {t.ms ? ` · ${(t.ms / 1000).toFixed(1)}s` : ""}
                </span>

                {/* The assistant's own text — same string LINE shows. */}
                <pre className="mt-2.5 rounded-[14px] border border-white/5 bg-slate-950/75 p-3 font-[family-name:var(--font-thai)] text-[13.5px] leading-[1.8] whitespace-pre-wrap text-slate-200">
                  {plainText(t.reply)}
                </pre>

                <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-white/10 pt-2.5">
                  <button
                    onClick={() => void copy(t)}
                    className={`rounded-[11px] border border-white/10 bg-slate-950/90 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-sky-400/50 hover:text-sky-300 ${monoFont}`}
                  >
                    {copied === t.id ? "คัดลอกแล้ว" : "คัดลอก"}
                  </button>
                  {(t.suggestions ?? []).slice(0, 4).map((s) => (
                    <button
                      key={s.text}
                      onClick={() => void send(s.text)}
                      disabled={busy}
                      className="rounded-[11px] border border-white/10 bg-slate-950/90 px-3 py-1 text-[11px] font-semibold text-slate-300 transition hover:border-sky-400/50 hover:text-sky-300 disabled:opacity-40"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </article>
        ))}
      </div>

      {/* ----------------------------------------------------------- composer */}
      <div className="border-t border-white/10 bg-[#070d1f]/90 px-3.5 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-xl">
        {/* LINE keeps a rich menu under every conversation, so there is always
            something to tap even when a reply carries no quick replies. Same
            nine texts, from lib/lineRichMenu.ts, so a tap here sends exactly
            what the LINE tile sends. */}
        <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {RICH_MENU_TILES.map((tile) => (
            <button
              key={tile.text}
              onClick={() => void send(tile.text)}
              disabled={busy}
              title={tile.sub}
              className="shrink-0 rounded-full border border-white/10 bg-slate-950/80 px-3 py-1 text-[11px] whitespace-nowrap text-slate-400 transition hover:border-sky-400/50 hover:text-sky-300 disabled:opacity-40"
            >
              {tile.label}
            </button>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <label htmlFor="cmd" className="sr-only">
            คำสั่ง
          </label>
          <textarea
            id="cmd"
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              grow(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            placeholder={`สั่งงาน เช่น ${dept.cmds[0]}`}
            className="max-h-[110px] min-h-11 w-full resize-none rounded-[14px] border border-white/10 bg-slate-950/90 px-3 py-2.5 text-[14px] leading-relaxed text-slate-100 placeholder:text-slate-600 focus:border-sky-400/60 focus:outline-none"
          />
          <button
            onClick={() => void send(draft)}
            disabled={busy || !draft.trim()}
            aria-label="ส่งคำสั่ง"
            className="mb-0.5 h-11 w-11 shrink-0 rounded-[14px] bg-gradient-to-tr from-sky-500 to-indigo-500 text-[17px] text-white transition disabled:opacity-35"
          >
            {busy ? "…" : "↑"}
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------- sheet */}
      {sheet && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setSheet(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="เลือกหมวดคำสั่ง"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80%] w-full overflow-y-auto rounded-t-[22px] border-t border-white/10 bg-[#0b1120] pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-white/20" />
            <p className={`px-4 pt-2.5 pb-2 text-[9.5px] tracking-[0.18em] text-slate-500 uppercase ${monoFont}`}>
              เลือกหมวด
            </p>
            {DEPTS.map((d) => (
              <button
                key={d.id}
                onClick={() => {
                  setActiveId(d.id);
                  setSheet(false);
                }}
                aria-current={d.id === dept.id ? "true" : undefined}
                className={`flex w-full items-center gap-2.5 border-b border-white/5 px-4 py-2.5 text-left last:border-b-0 ${
                  d.id === dept.id ? "bg-sky-400/10" : ""
                }`}
              >
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border text-[15px]"
                  style={{ background: d.tint, borderColor: d.ring }}
                >
                  {d.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-bold">{d.name}</span>
                  <span className="block text-[10px] leading-snug text-slate-500">{d.role}</span>
                </span>
                <span className={`text-[10px] text-slate-500 ${monoFont}`}>{d.cmds.length}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
