"use client";

/**
 * AI Office — a console for the assistant that answers in LINE.
 *
 * Why it looks the way it does:
 *
 * - It fills the window like a tool, not a document. The composer is pinned to
 *   the bottom, the transcript scrolls above it, newest last. The first cut of
 *   this page stacked panels from the top and left half the screen empty, which
 *   read as a page that had failed to load.
 * - Warm neutrals and one green accent, not the slate-and-sky palette every
 *   other screen here already uses — a person should be able to tell at a glance
 *   which surface they are on. Green because this drives the same assistant that
 *   replies in LINE.
 * - Machine-side text (command echo, time, intent, hints) is set in mono, the
 *   assistant's own words in Thai text. That carries the difference without a
 *   box around every message.
 * - The capability rail is generated from HELP_TOPICS in lib/help.ts — the same
 *   list the LINE help card and /help use, so it cannot drift from what the
 *   assistant actually answers.
 * - Nothing is fabricated when signed out: the API refuses the command and the
 *   line says so. No invented HR or finance numbers, unlike /ai-office.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  Check,
  Copy,
  Loader2,
  LogIn,
  MapPin,
  MonitorSmartphone,
  Moon,
  Sun,
  Terminal,
} from "lucide-react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";
import { HELP_TIPS, helpUrl, visibleTopics, type HelpTopic } from "@/lib/help";

type Theme = "system" | "light" | "dark";
const THEME_KEY = "aio_theme";

/**
 * The saved theme lives in localStorage, which the server cannot read. Reading
 * it through useSyncExternalStore keeps the first client render identical to the
 * server's ("system") and then swaps in the saved value — no hydration mismatch,
 * and no setState inside an effect.
 */
const themeListeners = new Set<() => void>();

function subscribeTheme(onChange: () => void): () => void {
  themeListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    themeListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // private mode
  }
}

function writeTheme(next: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* not persisted, but the switch still works for this visit */
  }
  themeListeners.forEach((cb) => cb());
}

type Turn = {
  id: number;
  prompt: string;
  at: string;
  /** null while the request is in flight. */
  reply: string | null;
  intent?: string;
  ms?: number;
  suggestions?: { label: string; text: string }[];
  mapUrl?: string;
  error?: string;
  /** The error was "not signed in" — offer the sign-in button on the line. */
  needsLogin?: boolean;
};

export default function AIOfficeConsolePage() {
  // The hook must run under the provider — read it in a child, never in the
  // component that renders <M365AuthProvider>, or it silently falls back to the
  // default context and every request goes out unauthenticated (the bug that
  // makes /ai-office show canned answers).
  return (
    <M365AuthProvider>
      <Console />
    </M365AuthProvider>
  );
}

/** Machine-side type: what the operator typed, timings, intent names, hints. */
const mono = "font-[family-name:var(--font-console-mono)]";

function Console() {
  const { account, isAuthenticated, ready, login, getToken, getGraphToken } = useM365Auth();
  const topics = useMemo(() => visibleTopics(), []);

  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as Theme);
  const [topicKey, setTopicKey] = useState<string>(topics[0]?.key ?? "");
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  /** Phone only: the rail does not fit, so the full list opens as a sheet. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  const topic: HelpTopic | undefined = topics.find((t) => t.key === topicKey) ?? topics[0];

  // Newest sits at the bottom, so the view follows it like a terminal.
  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  // Ctrl/⌘+K puts the cursor in the composer from anywhere on the page;
  // Esc closes the topic sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || busy) return;
      const id = nextId.current++;
      const at = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
      const started = Date.now();
      setTurns((prev) => [...prev, { id, prompt: clean, at, reply: null }]);
      setDraft("");
      grow(inputRef.current);
      setBusy(true);

      const finish = (patch: Partial<Turn>) =>
        setTurns((prev) =>
          prev.map((t) => (t.id === id ? { ...t, ms: Date.now() - started, ...patch } : t))
        );

      try {
        const token = await getToken();
        const graphToken = (await getGraphToken()) || undefined;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch("/api/command", {
          method: "POST",
          headers,
          body: JSON.stringify({ text: clean, graphToken }),
        });
        const data = (await res.json()) as {
          reply?: string;
          intent?: string;
          suggestions?: { label: string; text: string }[];
          map_url?: string | null;
          error?: string;
        };

        if (res.status === 401) {
          finish({
            error: "ต้องเข้าสู่ระบบ Microsoft 365 ก่อน — คำสั่งนี้ยังไม่ถูกประมวลผล",
            needsLogin: true,
          });
        } else if (data.reply) {
          finish({
            reply: data.reply,
            intent: data.intent,
            suggestions: data.suggestions,
            mapUrl: data.map_url || undefined,
          });
        } else {
          finish({ error: data.error || "ระบบไม่ได้ส่งคำตอบกลับมา" });
        }
      } catch (e) {
        finish({ error: `เรียก /api/command ไม่สำเร็จ — ${String(e).slice(0, 140)}` });
      } finally {
        setBusy(false);
      }
    },
    [busy, getGraphToken, getToken]
  );

  const copy = async (turn: Turn) => {
    if (!turn.reply) return;
    try {
      await navigator.clipboard.writeText(turn.reply);
      setCopied(turn.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — say nothing rather than claim it copied */
    }
  };

  const themeBtn = (id: Theme, Icon: React.ElementType, label: string) => (
    <button
      key={id}
      onClick={() => writeTheme(id)}
      aria-label={label}
      aria-pressed={theme === id}
      title={label}
      className={`rounded p-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
        theme === id
          ? "bg-stone-200 text-stone-900 dark:bg-stone-700 dark:text-stone-50"
          : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100"
      }`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );

  return (
    <div
      data-theme={theme === "system" ? undefined : theme}
      style={{
        colorScheme: theme === "system" ? "light dark" : theme,
        fontFamily: "var(--font-thai), system-ui, sans-serif",
      }}
      className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100"
    >
      {/* ------------------------------------------------------------- top bar */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-stone-300 px-4 py-2.5 dark:border-stone-800">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Terminal className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <h1 className="shrink-0 text-[15px] font-semibold tracking-tight">AI Office</h1>
          <span className={`hidden truncate text-xs text-stone-500 sm:block dark:text-stone-400 ${mono}`}>
            /api/command · ผู้ช่วยตัวเดียวกับที่ตอบใน LINE
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="ธีมหน้าจอ"
            className="flex gap-0.5 rounded-md border border-stone-300 p-0.5 dark:border-stone-700"
          >
            {themeBtn("system", MonitorSmartphone, "ตามระบบ")}
            {themeBtn("light", Sun, "สว่าง")}
            {themeBtn("dark", Moon, "มืด")}
          </div>

          {ready && !isAuthenticated ? (
            <button
              onClick={() => void login()}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden /> เข้าสู่ระบบ M365
            </button>
          ) : (
            <span className={`hidden max-w-[190px] truncate text-xs text-stone-500 sm:block dark:text-stone-400 ${mono}`}>
              {account?.username}
            </span>
          )}

          <Link
            href="/"
            className="rounded-md px-2 py-1.5 text-xs text-stone-600 transition hover:bg-stone-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            แชท
          </Link>
          <Link
            href="/monitor"
            className="hidden rounded-md px-2 py-1.5 text-xs text-stone-600 transition hover:bg-stone-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:block dark:text-stone-300 dark:hover:bg-stone-800"
          >
            มอนิเตอร์
          </Link>
        </div>
      </header>

      {/* ---------------------------------------------------- rail + transcript */}
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] min-[760px]:grid-cols-[15rem_minmax(0,1fr)] min-[760px]:grid-rows-1">
        <nav
          aria-label="หมวดคำสั่ง"
          className="min-w-0 border-b border-stone-300 min-[760px]:overflow-y-auto min-[760px]:border-r min-[760px]:border-b-0 dark:border-stone-800"
        >
          <p className={`hidden px-4 pt-4 pb-2 text-[11px] tracking-[0.14em] text-stone-500 uppercase min-[760px]:block ${mono}`}>
            สั่งอะไรได้
          </p>
          <ul className="flex gap-1 overflow-x-auto px-3 py-2 min-[760px]:flex-col min-[760px]:gap-0 min-[760px]:overflow-visible min-[760px]:px-2 min-[760px]:py-0">
            {topics.map((t, i) => {
              const active = t.key === topic?.key;
              // A phone fits about three of these. The rest live in the sheet,
              // except the one in use — it must always be visible, or the strip
              // would show three topics none of which is the current one.
              const onPhone = i < 3 || active;
              return (
                <li
                  key={t.key}
                  className={`shrink-0 min-[760px]:shrink ${onPhone ? "" : "hidden min-[760px]:block"}`}
                >
                  <button
                    onClick={() => setTopicKey(t.key)}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-[13px] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 min-[760px]:rounded-none min-[760px]:border-l-2 ${
                      active
                        ? "bg-emerald-500/10 text-emerald-800 min-[760px]:border-l-emerald-500 dark:text-emerald-200"
                        : "text-stone-600 hover:bg-stone-200/70 min-[760px]:border-l-transparent dark:text-stone-400 dark:hover:bg-stone-800/60"
                    }`}
                  >
                    <span className="shrink-0 text-xs" aria-hidden>{t.emoji}</span>
                    <span className="truncate">{t.title}</span>
                    <span className={`ml-auto hidden text-[10px] text-stone-400 min-[760px]:block ${mono}`}>
                      {t.commands.length}
                    </span>
                  </button>
                </li>
              );
            })}

            {/* Phone: everything the strip could not hold */}
            <li className="ml-auto shrink-0 min-[760px]:hidden">
              <button
                onClick={() => setSheetOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={sheetOpen}
                className={`rounded px-2.5 py-2 text-xs text-stone-600 transition hover:bg-stone-200/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-stone-400 dark:hover:bg-stone-800/60 ${mono}`}
              >
                ทั้งหมด ⌄
              </button>
            </li>
          </ul>
          <a
            href={helpUrl()}
            target="_blank"
            rel="noreferrer"
            className={`mx-4 my-4 hidden items-center gap-1.5 text-[11px] text-stone-500 hover:text-emerald-700 min-[760px]:inline-flex dark:hover:text-emerald-400 ${mono}`}
          >
            <BookOpen className="h-3 w-3" aria-hidden /> คู่มือทั้งหมด
          </a>
        </nav>

        {/* -------------------------------------------------- transcript column */}
        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]">
          <div className="min-h-0 overflow-y-auto px-4 py-4 min-[760px]:px-6">
            <div
              className={`mx-auto flex max-w-3xl flex-col gap-6 ${
                turns.length === 0 ? "min-h-full justify-center" : ""
              }`}
            >
              {ready && !isAuthenticated && (
                <p className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="max-w-prose">
                    ยังไม่ได้เข้าสู่ระบบ — API จะปฏิเสธคำสั่ง หน้านี้ไม่มีข้อมูลตัวอย่างปลอมให้ดู
                    ต้องล็อกอินก่อนจึงจะเห็นปฏิทินและไฟล์จริงของคุณ
                  </span>
                </p>
              )}

              {turns.length === 0 ? (
                <div className="py-10">
                  <p className={`text-[11px] tracking-[0.14em] text-stone-500 uppercase ${mono}`}>
                    {topic?.emoji} {topic?.title}
                  </p>
                  <p className="mt-2 max-w-prose text-sm text-stone-600 dark:text-stone-400">
                    {topic?.hint}
                  </p>
                  {topic?.note && (
                    <p className="mt-3 max-w-prose text-xs text-stone-500">{topic.note}</p>
                  )}
                  <p className="mt-6 max-w-prose text-xs text-stone-500">{HELP_TIPS[0]}</p>
                </div>
              ) : (
                turns.map((t) => (
                  <article key={t.id} className="flex flex-col gap-2">
                    {/* what the operator sent */}
                    <div className={`flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-xs ${mono}`}>
                      <span className="text-emerald-600 dark:text-emerald-400" aria-hidden>›</span>
                      <span className="font-medium text-stone-800 dark:text-stone-100">{t.prompt}</span>
                      <span className="text-stone-400 dark:text-stone-600">{t.at}</span>
                      {t.reply === null && !t.error && (
                        <span className="inline-flex items-center gap-1 text-stone-500">
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> กำลังประมวลผล
                        </span>
                      )}
                      {t.intent && !t.error && (
                        <span className="text-stone-400 dark:text-stone-600">
                          {t.intent}
                          {t.ms ? ` · ${(t.ms / 1000).toFixed(1)}s` : ""}
                        </span>
                      )}
                    </div>

                    {/* what came back */}
                    {t.error ? (
                      <div className="border-l-2 border-amber-500 pl-3">
                        <p className="text-sm text-amber-800 dark:text-amber-200">{t.error}</p>
                        {t.needsLogin && ready && !isAuthenticated && (
                          <button
                            onClick={() => void login()}
                            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          >
                            <LogIn className="h-3 w-3" aria-hidden /> เข้าสู่ระบบแล้วสั่งอีกครั้ง
                          </button>
                        )}
                      </div>
                    ) : t.reply === null ? (
                      <div
                        className="flex flex-col gap-2 border-l-2 border-stone-300 pl-3 dark:border-stone-800"
                        aria-hidden
                      >
                        <span className="h-3 w-3/5 animate-pulse rounded bg-stone-300 dark:bg-stone-800" />
                        <span className="h-3 w-2/5 animate-pulse rounded bg-stone-300 dark:bg-stone-800" />
                      </div>
                    ) : (
                      <div className="border-l-2 border-emerald-500/40 pl-3">
                        {/* The reply is written for chat — keep its own line breaks
                            instead of chopping it into one box per line. */}
                        <pre className="font-sans text-[15px] leading-relaxed whitespace-pre-wrap">
                          {t.reply}
                        </pre>

                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <button
                            onClick={() => void copy(t)}
                            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-stone-600 transition hover:bg-stone-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-stone-400 dark:hover:bg-stone-800 ${mono}`}
                          >
                            {copied === t.id ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden />{" "}
                                คัดลอกแล้ว
                              </>
                            ) : (
                              <>
                                <Copy className="h-3 w-3" aria-hidden /> คัดลอก
                              </>
                            )}
                          </button>

                          {t.mapUrl && (
                            <a
                              href={t.mapUrl}
                              target="_blank"
                              rel="noreferrer"
                              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-stone-600 transition hover:bg-stone-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-stone-400 dark:hover:bg-stone-800 ${mono}`}
                            >
                              <MapPin className="h-3 w-3" aria-hidden /> แผนที่
                            </a>
                          )}

                          {/* Follow-ups the API itself offered — the same ones LINE
                              shows as quick replies. */}
                          {(t.suggestions ?? []).slice(0, 5).map((s) => (
                            <button
                              key={s.text}
                              onClick={() => void send(s.text)}
                              disabled={busy}
                              className="rounded-full border border-stone-300 px-2.5 py-0.5 text-xs text-stone-700 transition hover:border-emerald-500 hover:text-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 dark:border-stone-700 dark:text-stone-300 dark:hover:border-emerald-500 dark:hover:text-emerald-300"
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </article>
                ))
              )}
              <div ref={tailRef} />
            </div>
          </div>

          {/* --------------------------------------------------------- composer */}
          <div className="border-t border-stone-300 bg-stone-50 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] min-[760px]:px-6 dark:border-stone-800 dark:bg-stone-900/60">
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {/* One scrolling line on a phone — wrapping these ate a third of
                  the screen before the composer even started. */}
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 min-[760px]:mx-0 min-[760px]:flex-wrap min-[760px]:overflow-visible min-[760px]:px-0">
                {(topic?.commands ?? []).map((c) => (
                  <button
                    key={c.text}
                    onClick={() => void send(c.text)}
                    disabled={busy}
                    title={c.text}
                    className="shrink-0 rounded-full border border-stone-300 bg-white px-2.5 py-1 text-xs whitespace-nowrap text-stone-700 transition hover:border-emerald-500 hover:text-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300 dark:hover:border-emerald-500 dark:hover:text-emerald-300"
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="flex items-end gap-2">
                <label htmlFor="aio-command" className="sr-only">
                  คำสั่ง
                </label>
                <span
                  className={`pb-3 text-sm text-emerald-600 select-none dark:text-emerald-400 ${mono}`}
                  aria-hidden
                >
                  ›
                </span>
                <textarea
                  id="aio-command"
                  ref={inputRef}
                  value={draft}
                  rows={1}
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
                  placeholder={
                    topic?.commands[0]?.text
                      ? `พิมพ์คำสั่ง เช่น ${topic.commands[0].text}`
                      : "พิมพ์คำสั่ง"
                  }
                  className="max-h-40 min-h-11 w-full resize-none rounded-md border border-stone-300 bg-white px-3 py-2.5 text-[15px] leading-relaxed text-stone-900 placeholder:text-stone-400 focus:border-emerald-500 focus:outline-none dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:placeholder:text-stone-600"
                />
                <button
                  onClick={() => void send(draft)}
                  disabled={busy || !draft.trim()}
                  aria-label="ส่งคำสั่ง"
                  className="mb-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-emerald-600 text-white transition hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>

              <p className={`hidden text-[11px] text-stone-500 min-[760px]:block ${mono}`}>
                Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่ · Ctrl/⌘+K โฟกัส
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ----------------------------------------- topic sheet (phone only) */}
      {sheetOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/45 min-[760px]:hidden"
          onClick={() => setSheetOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="เลือกหมวดคำสั่ง"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[78%] w-full overflow-y-auto rounded-t-2xl bg-stone-50 pb-[max(1rem,env(safe-area-inset-bottom))] dark:bg-stone-900"
          >
            <div className="sticky top-0 bg-stone-50 pt-2.5 pb-1 dark:bg-stone-900">
              <div className="mx-auto h-1 w-9 rounded-full bg-stone-300 dark:bg-stone-700" />
              <p className={`px-4 pt-2.5 pb-1 text-[11px] tracking-[0.14em] text-stone-500 uppercase ${mono}`}>
                สั่งอะไรได้
              </p>
            </div>
            <ul>
              {topics.map((t) => {
                const active = t.key === topic?.key;
                return (
                  <li key={t.key}>
                    <button
                      onClick={() => {
                        setTopicKey(t.key);
                        setSheetOpen(false);
                      }}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-start gap-2.5 border-b border-stone-200 px-4 py-2.5 text-left transition last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-stone-800 ${
                        active ? "bg-emerald-500/10" : ""
                      }`}
                    >
                      <span aria-hidden>{t.emoji}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-sm ${active ? "font-medium text-emerald-800 dark:text-emerald-200" : ""}`}>
                          {t.title}
                        </span>
                        <span className="block text-xs leading-snug text-stone-500">{t.hint}</span>
                      </span>
                      <span className={`text-[10px] text-stone-400 ${mono}`}>{t.commands.length}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
