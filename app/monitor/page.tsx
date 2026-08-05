"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

// ---------------------------------------------------------------------------
// /monitor — "AI at work" room. A pixel office where each desk is a real stage
// of the assistant pipeline. Driven by /api/monitor/events (polled), which
// streams STAGE events only (no user message content). M365 login required.
// Pixel-office rendering adapted from tech-brief-agent/pixel-monitor.html.
// ---------------------------------------------------------------------------

type StageId = "receive" | "parse" | "fetch" | "compose" | "reply";

type MonEvent = {
  id: number;
  traceId: string;
  user: string;
  channel: string;
  step: string;
  label: string;
  status: string;
  seq: number;
  ms: number;
  at: string;
};

// 4 desks + 1 courier — the courier (reply) walks the parcel to the LINE mailbox.
const AGENTS = [
  { id: "receive", name: "GATE", role: "RECEIVE", cap: "รับข้อความเข้าจากผู้ใช้", shirt: "#3a86ff", hair: "#6b4a2e", screen: "search" },
  { id: "parse", name: "BRAIN", role: "PARSE", cap: "แยกเจตนา (intent) ด้วย LLM", shirt: "#2f9e44", hair: "#2a2a2a", screen: "filter" },
  { id: "fetch", name: "RUNNER", role: "FETCH", cap: "ดึงข้อมูลจาก Microsoft 365", shirt: "#f0b429", hair: "#caa15a", screen: "search" },
  { id: "compose", name: "SCRIBE", role: "COMPOSE", cap: "เขียนคำตอบภาษาไทย", shirt: "#7048e8", hair: "#7a4a2a", screen: "render" },
  { id: "courier", name: "DASH", role: "REPLY", cap: "ใส่ตู้จดหมาย → ส่ง LINE (เร็ว=วิ่ง)", shirt: "#ee1b24", hair: "#141414", screen: "" },
] as const;

const NEWS_AGENTS = [
  { id: "scout", name: "SCOUT", role: "ดึงแหล่ง", shirt: "#14b8a6", hair: "#0f766e", screen: "search" },
  { id: "picker", name: "PICKER", role: "เลือกเด่น", shirt: "#b45309", hair: "#78350f", screen: "filter" },
  { id: "reader", name: "READER", role: "อ่านบทความ", shirt: "#ec4899", hair: "#9d174d", screen: "search" },
  { id: "writer", name: "WRITER", role: "สรุป", shirt: "#e879f9", hair: "#a21caf", screen: "render" },
] as const;

/** WRITER desk (canvas px) — POSTIE picks here via aisle */
const NEWS_WRITER_DESK = [250, 168] as const;
const NEWS_AISLE_X = 160;
const NEWS_WRITER_PICKUP = [218, 190] as const; // spur off aisle to WRITER
const NEWS_DOOR = [18, 140] as const;
const OFFICE_DOOR = [302, 140] as const;
const OFFICE_AISLE_X = 160;
const OFFICE_MAIL = [160, 198] as const;

const STEP_TO_INDEX: Record<StageId, number> = { receive: 0, parse: 1, fetch: 2, compose: 3, reply: 4 };

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap');
.mon{--bg:#0a0a0a;--panel:#121212;--panel2:#171717;--ink:#f5f5f5;--dim:#7c7c7c;--red:#ee1b24;--green:#39d353;--amber:#f0b429;--hair:#262626;background:var(--bg);color:var(--ink);font-family:'VT323',monospace;height:100vh;overflow:hidden;padding:6px 8px;position:relative;display:flex;flex-direction:column}
.mon *{margin:0;padding:0;box-sizing:border-box}
.mon::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:60;background:repeating-linear-gradient(0deg,rgba(0,0,0,0.14) 0 1px,transparent 1px 3px);mix-blend-mode:multiply}
.mon .pix{font-family:'Press Start 2P',monospace}
.mon .wrap{flex:1;min-height:0;display:flex;flex-direction:column;max-width:100%;width:100%;margin:0 auto}
.mon header{display:flex;align-items:center;gap:10px;flex-wrap:nowrap;border:2px solid var(--hair);background:var(--panel);padding:8px 12px;margin-bottom:6px;flex-shrink:0}
.mon header .mark{width:28px;height:28px;flex:none}
.mon header h1{font-size:13px;line-height:1.3}.mon header h1 em{color:var(--red);font-style:normal}
.mon header .spacer{flex:1}
.mon .badge{font-size:14px;color:var(--dim);border:1px solid var(--hair);padding:2px 6px}.mon .badge b{color:var(--green)}
.mon .badge.llm b{color:var(--amber)}
.mon .badge.llm.hot b{color:#fff;animation:monpulse .7s steps(1) infinite}
.mon .badges{display:flex;gap:6px;flex-wrap:nowrap;align-items:center}
.mon .panel{border:2px solid var(--hair);background:var(--panel);margin-bottom:6px}
.mon .ph{font-family:'Press Start 2P';font-size:8px;color:var(--dim);padding:6px 9px;border-bottom:2px solid var(--hair);background:var(--panel2);display:flex;justify-content:space-between}
.mon .ph .live{color:var(--red)}
.mon .room-frame{position:relative;aspect-ratio:320/240;height:100%;width:auto;max-width:100%;margin:0 auto;flex:none}
.mon #room,.mon #news-room{width:100%;height:100%;display:block;image-rendering:pixelated;background:#2e2116}
.mon .building{flex:1;min-height:0;display:flex;flex-direction:column;margin-bottom:6px;overflow:hidden}
.mon .building-ph{display:grid;grid-template-columns:1fr 6px 1fr;gap:0;padding:4px 6px}
.mon .building-ph .room-tag{font-family:'Press Start 2P';font-size:8px;color:var(--dim);display:flex;justify-content:space-between;align-items:center;gap:6px}
.mon .building-ph .wall-bar{background:transparent}
.mon .building-stage{position:relative;flex:1;min-height:0;display:grid;grid-template-columns:1fr 6px 1fr;background:#1a120a;padding:4px 4px 2px;align-items:center;column-gap:0}
.mon .building-wall{position:relative;background:linear-gradient(180deg,#2e2116 0%,#2e2116 52px,#5f4527 52px,#6b4a2e 100%);border-left:1px solid #1c140c;border-right:1px solid #1c140c;align-self:stretch;min-height:0;width:6px}
.mon .building-wall .door{position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);width:4px;height:28px;background:#6b4a2e;border:1px solid #3a2a1a;z-index:1}
.mon .building-wall .door.open{background:#1a120a;border-color:#39d353;box-shadow:0 0 4px #39d35355}
.mon .building-wing{min-width:0;min-height:0;display:flex;flex-direction:column;justify-content:center;height:100%}
.mon .office-wing{align-items:flex-end;padding-right:0}
.mon .news-wing{align-items:flex-start;padding-left:0}
.mon .building-wing .room-frame{border:2px solid #3a2a1a;margin:0}
.mon .office-wing .room-frame{border-right:none}
.mon .news-wing .room-frame{border-left:none}
.mon .wing-cap{font-size:14px;color:var(--dim);text-align:center;padding:2px 4px;line-height:1.2;flex-shrink:0;width:100%}
.mon .wing-cap b{color:var(--red)}
.mon .news-courier{position:absolute;transform:translate(-50%,-100%);z-index:8;pointer-events:none;text-align:center;background:rgba(10,7,4,.94);border:2px solid #38bdf8;padding:2px 4px;display:none}
.mon .news-courier .nm{font-family:'Press Start 2P';font-size:6px;color:#38bdf8;display:block}
.mon .news-courier .body{width:10px;height:10px;background:#38bdf8;margin:2px auto 0;border-top:2px solid #0284c7}
.mon .news-courier.carry .body::after{content:"📰";font-size:8px;display:block;margin-top:-2px}
.mon .bdg{position:absolute;transform:translate(-50%,-100%);text-align:center;pointer-events:none;background:rgba(10,7,4,.92);border:2px solid var(--hair);padding:2px 4px 1px;white-space:nowrap;line-height:1;transition:left .05s linear,top .05s linear;z-index:2}
.mon .bdg .nm{font-family:'Press Start 2P';font-size:6px;color:var(--ink);display:block;margin-bottom:2px}
.mon .bdg .stt{font-family:'Press Start 2P';font-size:6px}
.mon .bdg .dot{display:inline-block;width:4px;height:4px;margin-right:3px;vertical-align:middle;background:var(--dim)}
.mon .bdg.idle .stt{color:var(--dim)}.mon .bdg.idle .dot{background:var(--dim)}
.mon .bdg.work{border-color:var(--amber)}.mon .bdg.work .stt{color:var(--amber)}.mon .bdg.work .dot{background:var(--amber);animation:monpulse .55s steps(1) infinite}
.mon .bdg.done{border-color:var(--green)}.mon .bdg.done .stt{color:var(--green)}.mon .bdg.done .dot{background:var(--green)}
.mon .bdg.error{border-color:var(--red)}.mon .bdg.error .stt{color:var(--red)}.mon .bdg.error .dot{background:var(--red)}
@keyframes monpulse{50%{opacity:.2}}
.mon .caption{font-size:19px;color:var(--dim);text-align:center;padding:9px}.mon .caption b{color:var(--red)}
.mon .cols{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(320px,480px);gap:6px;align-items:stretch;flex-shrink:0;height:clamp(150px,24vh,210px);margin-bottom:0}
@media(max-width:900px){.mon .cols{grid-template-columns:minmax(0,1fr);height:auto;max-height:32vh}}
.mon .cols > .panel{min-width:0;max-width:100%;overflow:hidden;margin-bottom:0;display:flex;flex-direction:column}
.mon .cols > .panel .ph{flex-shrink:0;padding:4px 8px}
.mon #log{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;font-size:14px;line-height:1.15;padding:4px 8px}
.mon #log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.mon #log .t{color:var(--dim)}.mon #log .g{color:var(--green)}.mon #log .r{color:var(--red)}.mon #log .a{color:var(--amber)}.mon #log .b{color:#3a86ff}
.mon #legend{flex:1;min-height:0;overflow:hidden;padding:4px 6px;font-size:12px;line-height:1.15;display:grid;grid-template-columns:1fr 1fr;gap:0 12px;align-content:start}
.mon #legend .leg-col{display:flex;flex-direction:column;gap:1px;min-width:0}
.mon #legend .leg-h{font-family:'Press Start 2P';font-size:5px;color:var(--dim);margin:0 0 2px;letter-spacing:0.5px}
.mon #legend .row{display:flex;align-items:center;gap:4px;margin:0;min-width:0;height:16px}
.mon #legend .row > span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mon #legend .row.span2{grid-column:1 / -1;height:auto;min-height:16px;margin-top:3px;align-items:flex-start}
.mon #legend .row.span2 > span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mon #legend .sw{width:8px;height:8px;flex:none;border:1px solid #000}
.mon #legend .rl{font-family:'Press Start 2P';font-size:5px;color:var(--ink)}
.mon #legend .rc{color:var(--dim);font-size:12px}
.mon .foot{display:none}
.mon .news-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:4px 8px 6px;border-top:2px solid var(--hair);flex-shrink:0}
@media(max-width:1100px){.mon .news-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.mon .news-desk{border:2px solid var(--hair);background:var(--panel2);padding:4px 6px;min-width:0}
.mon .news-desk .hd{font-family:'Press Start 2P';font-size:6px;display:flex;justify-content:space-between;align-items:center;gap:4px;margin-bottom:3px}
.mon .news-desk .nm{color:var(--ink)}.mon .news-desk .st{font-size:5px;padding:1px 3px;border:1px solid var(--hair);color:var(--dim)}
.mon .news-desk.work .st{color:var(--amber);border-color:var(--amber);animation:monpulse .55s steps(1) infinite}
.mon .news-desk.done .st{color:var(--green);border-color:var(--green)}
.mon .news-desk.error .st{color:var(--red);border-color:var(--red)}
.mon .news-desk .ai{font-size:13px;color:var(--amber);margin:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mon .news-desk .cap{font-size:12px;color:var(--dim);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mon .news-desk ul{list-style:none;font-size:12px;color:var(--ink);line-height:1.2;max-height:2.4em;overflow:hidden}
.mon .news-desk li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:1px}
.mon .news-desk li .k{color:var(--dim)}.mon .news-desk li.work{color:var(--amber)}.mon .news-desk li.done{color:var(--green)}.mon .news-desk li.err{color:var(--red)}
.mon .btn{font-family:'Press Start 2P';font-size:10px;background:var(--ink);color:#000;border:2px solid var(--ink);padding:10px 16px;cursor:pointer}
.mon .center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:60vh;text-align:center}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type NewsSourceRow = { key: string; text: string; status: "work" | "done" | "error" };
type NewsDesk = { status: "idle" | "work" | "done" | "error"; ai: string; detail: string };

const NEWS_SCOUT_IDLE: NewsDesk = { status: "idle", ai: "—", detail: "รอคำขอข่าว…" };
const NEWS_PICKER_IDLE: NewsDesk = { status: "idle", ai: "—", detail: "AI เลือกข่าวเด่น" };
const NEWS_READER_IDLE: NewsDesk = { status: "idle", ai: "—", detail: "อ่านบทความเต็ม" };
const NEWS_WRITER_IDLE: NewsDesk = { status: "idle", ai: "—", detail: "AI สรุปประเด็น" };

function parseNewsAi(label: string): string | null {
  const m = label.match(/★\s*AI:([A-Z]+)\s*·\s*([^\s✓✗·]+)/i) || label.match(/AI:([A-Z]+)\s*·\s*([^\s✓✗·]+)/i);
  if (!m) return null;
  return `${m[1].toUpperCase()} · ${m[2]}`;
}

// Online (Vercel build) → NODE_ENV=production → M365 login required.
// Local `next dev` → development → open, no login (watch the room while working).
const DEV = process.env.NODE_ENV !== "production";

// ----- canvas art (ported, trimmed) -----
type Dash = {
  x: number; y: number; tx: number | null; ty: number | null;
  face: string; moving: boolean; phase: number; carry: boolean;
  speed: number; running: boolean; visible: boolean;
  onArrive: (() => void) | null;
};
type Postie = {
  x: number; y: number; tx: number | null; ty: number | null;
  carry: boolean; visible: boolean; running: boolean; phase: number;
  onArrive: (() => void) | null;
};

function MonitorRoom({ getToken, account }: { getToken: () => Promise<string | null>; account: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const newsCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const capRef = useRef<HTMLDivElement | null>(null);
  const newsCapRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLElement | null>(null);
  const llmHudRef = useRef<HTMLElement | null>(null);
  const badgesRef = useRef<HTMLDivElement[]>([]);
  const newsBadgesRef = useRef<HTMLDivElement[]>([]);
  const newsStatusRef = useRef<string[]>(NEWS_AGENTS.map(() => "idle"));
  const postieRef = useRef<Postie>({
    x: 160, y: 150, tx: null, ty: null, carry: false, visible: false, running: false, phase: 0, onArrive: null,
  });
  const doorElRef = useRef<HTMLDivElement | null>(null);
  const doorOpenRef = useRef(false);

  const statusRef = useRef<string[]>(AGENTS.map(() => "idle"));
  const dashRef = useRef<Dash>({
    x: 160, y: 150, tx: null, ty: null, face: "down", moving: false, phase: 0,
    carry: false, speed: 0.9, running: false, visible: true, onArrive: null,
  });
  const helperRef = useRef<Dash>({
    x: 200, y: 120, tx: null, ty: null, face: "down", moving: false, phase: 0,
    carry: false, speed: 1.1, running: false, visible: false, onArrive: null,
  });
  const mailFlashRef = useRef(0);
  const mailHasParcelRef = useRef(false);
  const writerHasParcelRef = useRef(false);
  const newsJobRef = useRef(false);
  const newsDeliveredRef = useRef(false);
  const newsScoutWatchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const traceStartedAtRef = useRef(0);

  // event pipeline
  const queueRef = useRef<MonEvent[]>([]);
  const seenEventIdsRef = useRef<Set<number>>(new Set());
  const cursorRef = useRef(0);
  const curTraceRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const primedRef = useRef(false);
  const [status, setStatus] = useState("IDLE");
  const [llmLabel, setLlmLabel] = useState("");
  const [llmHot, setLlmHot] = useState(false);
  const [llmChain, setLlmChain] = useState("");
  const lastLlmRef = useRef("—");
  const [newsScoutStatus, setNewsScoutStatus] = useState<NewsDesk["status"]>("idle");
  const [newsSources, setNewsSources] = useState<NewsSourceRow[]>([]);
  const [newsPicker, setNewsPicker] = useState<NewsDesk>(NEWS_PICKER_IDLE);
  const [newsReader, setNewsReader] = useState<NewsDesk>(NEWS_READER_IDLE);
  const [newsWriter, setNewsWriter] = useState<NewsDesk>(NEWS_WRITER_IDLE);

  useEffect(() => {
    newsStatusRef.current = [newsScoutStatus, newsPicker.status, newsReader.status, newsWriter.status];
    NEWS_AGENTS.forEach((_, i) => {
      const b = newsBadgesRef.current[i];
      if (!b) return;
      const st = newsStatusRef.current[i] || "idle";
      b.className = "bdg " + st;
      const w = b.querySelector(".w");
      if (w) w.textContent = st === "work" ? "WORKING" : st === "done" ? "DONE" : st === "error" ? "ERROR" : "IDLE";
    });
    if (newsCapRef.current) {
      if (newsScoutStatus === "work") newsCapRef.current.innerHTML = "<b>SCOUT</b> — กำลังดึงข่าวจากแหล่งที่ติดตาม…";
      else if (newsPicker.status === "work") newsCapRef.current.innerHTML = `<b>PICKER</b> — AI เลือกข่าวเด่น · <b style="color:#f0b429">${newsPicker.ai}</b>`;
      else if (newsReader.status === "work") newsCapRef.current.innerHTML = `<b>READER</b> — ${newsReader.detail}`;
      else if (newsWriter.status === "work") newsCapRef.current.innerHTML = `<b>WRITER</b> — AI สรุปประเด็น · <b style="color:#f0b429">${newsWriter.ai}</b>`;
      else if (newsWriter.status === "done") newsCapRef.current.innerHTML = `<b>เสร็จ</b> — สรุปข่าว ${newsWriter.detail.replace(/^📰 สรุปเสร็จ · /, "")}`;
      else newsCapRef.current.textContent = "รอคำขอ “ข่าววันนี้” จาก LINE / Web…";
    }
  }, [newsScoutStatus, newsPicker, newsReader, newsWriter]);

  const parseLlm = (label: string): string | null => {
    if (/AI:NONE|ไม่ใช้\s*LLM|กฎตายตัว|ติดตามเวลา|ไม่เรียก API/i.test(label)) return "NONE · กฎ";
    const star =
      label.match(/★\s*AI:([A-Z]+)\s*·\s*([^\s✓✗·]+)/i) ||
      label.match(/AI:([A-Z]+)\s*·\s*([^\s✓✗·]+)/i);
    if (star) return `${star[1].toUpperCase()} · ${star[2]}`;
    const fb = label.match(/AI:fallback\s*→\s*([A-Z]+)/i);
    if (fb) return fb[1].toUpperCase();
    const m =
      label.match(/LLM\s+([A-Z]+)\s*·\s*([^\s✓]+)/i) ||
      label.match(/\(([a-z]+)\s*·\s*([^)]+)\)/i) ||
      label.match(/\b(qwen|groq|gemini)\b/i);
    if (!m) return null;
    if (m[2]) return `${m[1].toUpperCase()} · ${m[2]}`;
    return m[1].toUpperCase();
  };

  const setLlmHud = useCallback((text: string, hot = false) => {
    lastLlmRef.current = text;
    setLlmLabel(text);
    setLlmHot(hot);
    if (llmHudRef.current) {
      llmHudRef.current.textContent = text;
      llmHudRef.current.style.color = hot ? "#fff" : "var(--amber)";
    }
  }, []);

  const log = useCallback((m: string, c = "t") => {
    const el = logRef.current;
    if (!el) return;
    const d = document.createElement("div");
    d.className = c;
    d.textContent = m;
    el.appendChild(d);
    while (el.children.length > 40) el.removeChild(el.firstChild!);
    el.scrollTop = el.scrollHeight;
  }, []);

  const setAgent = useCallback((i: number, st: string) => {
    statusRef.current[i] = st;
    const b = badgesRef.current[i];
    if (!b) return;
    b.className = "bdg " + st;
    const w = b.querySelector(".w");
    if (w) w.textContent = st === "work" ? "WORKING" : st === "done" ? "DONE" : "IDLE";
  }, []);

  const setHud = useCallback((t: string, c?: string) => {
    setStatus(t);
    if (hudRef.current) {
      hudRef.current.textContent = t;
      hudRef.current.style.color = c || "var(--green)";
    }
  }, []);

  const setCap = useCallback((html: string) => {
    if (capRef.current) capRef.current.innerHTML = html;
  }, []);

  const clearNewsScoutWatch = useCallback(() => {
    if (newsScoutWatchRef.current) {
      clearTimeout(newsScoutWatchRef.current);
      newsScoutWatchRef.current = null;
    }
  }, []);

  const idleNewsDesks = useCallback(() => {
    clearNewsScoutWatch();
    setNewsScoutStatus("idle");
    setNewsSources([]);
    setNewsPicker(NEWS_PICKER_IDLE);
    setNewsReader(NEWS_READER_IDLE);
    setNewsWriter(NEWS_WRITER_IDLE);
    writerHasParcelRef.current = false;
  }, [clearNewsScoutWatch]);

  const resetNewsRoom = useCallback(() => {
    idleNewsDesks();
    newsJobRef.current = false;
    newsDeliveredRef.current = false;
    const p = postieRef.current;
    p.visible = false;
    p.carry = false;
    p.tx = null;
    p.ty = null;
    p.onArrive = null;
    doorOpenRef.current = false;
    if (doorElRef.current) doorElRef.current.classList.remove("open");
  }, [idleNewsDesks]);

  /** SCOUT (teal / เขียวอ่อน) must never bob forever if digest stalls after timeout. */
  const armNewsScoutWatch = useCallback(() => {
    clearNewsScoutWatch();
    newsScoutWatchRef.current = setTimeout(() => {
      newsScoutWatchRef.current = null;
      setNewsScoutStatus((s) => (s === "work" ? "idle" : s));
      setNewsPicker((p) => (p.status === "work" ? { ...NEWS_PICKER_IDLE } : p));
      setNewsReader((p) => (p.status === "work" ? { ...NEWS_READER_IDLE } : p));
      setNewsWriter((p) => (p.status === "work" ? { ...NEWS_WRITER_IDLE } : p));
      writerHasParcelRef.current = false;
      const p = postieRef.current;
      p.visible = false; p.carry = false; p.tx = null; p.ty = null; p.onArrive = null;
      doorOpenRef.current = false;
      if (doorElRef.current) doorElRef.current.classList.remove("open");
      if (newsCapRef.current) newsCapRef.current.textContent = "รอคำขอ “ข่าววันนี้” จาก LINE / Web…";
    }, 90_000);
  }, [clearNewsScoutWatch]);

  const upsertNewsSource = useCallback((key: string, text: string, status: NewsSourceRow["status"]) => {
    setNewsSources((prev) => {
      const i = prev.findIndex((r) => r.key === key);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { key, text, status };
        return next;
      }
      return [...prev, { key, text, status }];
    });
  }, []);

  const updateNewsRoom = useCallback((e: MonEvent) => {
    const lbl = e.label || "";
    if (!lbl.includes("📰")) return;

    const err = e.status === "error" || /✗/.test(lbl);

    if (/📰 สรุปข่าวช้า/.test(lbl)) {
      // Interim LINE reply — keep SCOUT visible briefly, but auto-clear if digest dies.
      armNewsScoutWatch();
      if (newsCapRef.current) {
        newsCapRef.current.innerHTML = "<b>SCOUT</b> — สรุปช้า · รอส่งต่อหลังบ้าน…";
      }
      return;
    }

    if (/📰 RSS ·/.test(lbl) || /📰 Facebook ·/.test(lbl) || /📰 YouTube ·/.test(lbl) || /📰 NewsData ·/.test(lbl) || /📰 ดึงข่าวจากแหล่ง/.test(lbl) || /📰 เริ่มรวบรวมข่าว/.test(lbl)) {
      setNewsScoutStatus(err ? "error" : "work");
      if (!err) armNewsScoutWatch();
      if (/📰 RSS ·/.test(lbl)) {
        const name = lbl.replace(/^📰 RSS · /, "").replace(/ · \d+ รายการ$/, "").replace(/ ✗$/, "");
        const key = `rss:${name}`;
        if (e.status === "start") upsertNewsSource(key, `RSS · ${name}`, "work");
        else upsertNewsSource(key, lbl.replace(/^📰 /, ""), err ? "error" : "done");
      } else if (/📰 Facebook ·/.test(lbl)) {
        const name = lbl.replace(/^📰 Facebook · /, "").replace(/ · \d+ โพสต์$/, "").replace(/ ✗$/, "");
        const key = `fb:${name}`;
        if (e.status === "start") upsertNewsSource(key, `Facebook · ${name}`, "work");
        else upsertNewsSource(key, lbl.replace(/^📰 /, ""), err ? "error" : "done");
      } else if (/📰 YouTube ·/.test(lbl)) {
        const key = "yt";
        if (e.status === "start") upsertNewsSource(key, "YouTube · subscriptions", "work");
        else upsertNewsSource(key, lbl.replace(/^📰 /, ""), err ? "error" : "done");
      } else if (/📰 NewsData ·/.test(lbl)) {
        const topic = lbl.replace(/^📰 NewsData · /, "").replace(/ · \d+ รายการ$/, "");
        const key = `nd:${topic}`;
        if (e.status === "start") upsertNewsSource(key, `NewsData · ${topic}`, "work");
        else upsertNewsSource(key, lbl.replace(/^📰 /, ""), err ? "error" : "done");
      }
      return;
    }

    if (/📰 เลือกเด่น/.test(lbl)) {
      setNewsScoutStatus((s) => (s === "work" ? "done" : s));
      clearNewsScoutWatch();
      const ai = parseNewsAi(lbl);
      if (e.status === "start" || ai) {
        setNewsPicker((p) => ({
          status: err ? "error" : e.status === "start" || !/✓/.test(lbl) ? "work" : "done",
          ai: ai || p.ai,
          detail: lbl.replace(/^📰 เลือกเด่น · /, "").replace(/^★ /, ""),
        }));
      } else if (/ได้ \d+ เรื่อง/.test(lbl)) {
        setNewsPicker((p) => ({ ...p, status: "done", detail: lbl.replace(/^📰 /, "") }));
      }
      return;
    }

    if (/📰 อ่านบทความ/.test(lbl)) {
      setNewsPicker((p) => (p.status === "work" ? { ...p, status: "done" } : p));
      setNewsReader({
        status: err ? "error" : e.status === "start" ? "work" : "done",
        ai: "—",
        detail: lbl.replace(/^📰 /, ""),
      });
      return;
    }

    if (/📰 สรุปประเด็น/.test(lbl)) {
      setNewsReader((p) => (p.status === "work" ? { ...p, status: "done" } : p));
      const ai = parseNewsAi(lbl);
      setNewsWriter((p) => ({
        status: err ? "error" : e.status === "start" || (ai && !/✓/.test(lbl)) ? "work" : "done",
        ai: ai || p.ai,
        detail: lbl.replace(/^📰 สรุปประเด็น · /, "").replace(/^★ /, ""),
      }));
      return;
    }

    if (/📰 สรุปเสร็จ|📰 ได้ข่าว|📰 สรุปข่าวภาษาไทย|📰 ตอบกลับ/.test(lbl)) {
      clearNewsScoutWatch();
      setNewsScoutStatus((s) => (s === "idle" ? s : "done"));
      setNewsPicker((p) => (p.status === "idle" ? p : { ...p, status: "done" }));
      setNewsReader((p) => (p.status === "idle" ? p : { ...p, status: "done" }));
      setNewsWriter((p) => ({ ...p, status: "done", detail: lbl.replace(/^📰 /, "") }));
    }
  }, [armNewsScoutWatch, clearNewsScoutWatch, upsertNewsSource]);

  // ---- canvas render loop ----
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const X = cv.getContext("2d")!;
    X.imageSmoothingEnabled = false;
    const W = cv.width, H = cv.height;
    const DESK = [[70, 92], [250, 92], [70, 168], [250, 168]];
    // Seats sit clearly below the desk so brand shirt colors stay visible even when IDLE.
    const SEAT = [[70, 126], [250, 126], [70, 202], [250, 202]];
    const MAILBOX = [160, 214];
    const SPINES = ["#c0392b", "#e67e22", "#f1c40f", "#27ae60", "#2980b9", "#8e44ad", "#d35400", "#16a085", "#c0392b", "#2c3e50"];
    const R = (x: number, y: number, w: number, h: number, c: string) => { X.fillStyle = c; X.fillRect(Math.round(x), Math.round(y), Math.max(1, w | 0), Math.max(1, h | 0)); };

    // Pin each desk badge on the monitor (screen top ≈ dy-7).
    // Percentages are relative to .room-frame (same box as the canvas).
    badgesRef.current.forEach((b, i) => {
      if (i < 4) { b.style.left = (DESK[i][0] / 320 * 100) + "%"; b.style.top = ((DESK[i][1] - 7) / 240 * 100) + "%"; }
    });
    const dashB = badgesRef.current[4];
    if (dashB) { dashB.style.left = (160 / 320 * 100) + "%"; dashB.style.top = ((150 - 20) / 240 * 100) + "%"; }

    function drawDoorRight() {
      const open = doorOpenRef.current;
      R(312, 120, 8, 32, "#5f4527");
      R(313, 122, 6, 28, open ? "#1a120a" : "#6b4a2e");
      if (open) { R(313, 122, 2, 28, "#39d353"); R(317, 122, 2, 28, "#39d353"); }
    }
    function drawFloor() {
      R(0, 52, W, H - 52, "#7a5636");
      for (let y = 52; y < H; y += 10) R(0, y, W, 1, "#6b4a2e");
      for (let x = 0; x < W - 14; x += 40) R(x, 52, 1, H - 52, "#6e4d30");
      // Center vertical aisle + horizontal crosswalk to door / desks
      R(140, 52, 40, H - 52, "#a07850");
      for (let y = 52; y < H; y += 8) R(140, y, 40, 1, "#8a6540");
      R(139, 52, 1, H - 52, "#5f4527"); R(180, 52, 1, H - 52, "#5f4527");
      // dashed center line on aisle
      for (let y = 56; y < H - 8; y += 12) R(158, y, 4, 6, "#c9a06a");
      // Horizontal corridor at door height
      R(0, 128, W, 28, "#a07850");
      for (let x = 0; x < W; x += 10) R(x, 128, 1, 28, "#8a6540");
      R(0, 128, W, 1, "#5f4527"); R(0, 155, W, 1, "#5f4527");
      for (let x = 4; x < W - 4; x += 14) R(x, 140, 8, 2, "#c9a06a");
      // Spurs toward each desk column
      R(46, 100, 28, 18, "#946f49"); R(246, 100, 28, 18, "#946f49");
      R(46, 176, 28, 18, "#946f49"); R(246, 176, 28, 18, "#946f49");
      drawDoorRight();
    }
    function drawWalls() {
      R(0, 0, W, 52, "#2e2116"); R(0, 50, W, 2, "#1c140c");
      ([[8, 140], [172, 140]] as number[][]).forEach(([bx, bw]) => {
        R(bx, 8, bw, 40, "#4a3420"); X.strokeStyle = "#5c4228"; X.strokeRect(bx + .5, 8.5, bw - 1, 39);
        for (let r = 0; r < 3; r++) { const ry = 12 + r * 13; R(bx + 2, ry + 9, bw - 4, 2, "#3a281a"); for (let s = 0; s < Math.floor((bw - 6) / 4); s++) R(bx + 3 + s * 4, ry, 3, 9, SPINES[(s + r * 3) % SPINES.length]); }
      });
      R(150, 10, 20, 10, "#ee1b24"); R(150, 10, 20, 2, "#b3121a"); R(153, 13, 14, 2, "#0a0a0a"); R(153, 16, 10, 1, "#0a0a0a");
    }
    function drawPlant(x: number, y: number) { R(x - 3, y - 2, 7, 5, "#8a5a2a"); R(x - 4, y + 3, 9, 3, "#6b4420"); R(x - 2, y - 8, 3, 6, "#2f7d32"); R(x - 5, y - 6, 3, 4, "#2f7d32"); R(x + 2, y - 6, 3, 4, "#39d353"); R(x - 1, y - 11, 2, 3, "#39d353"); }

    function drawScreen(mx: number, my: number, mw: number, mh: number, id: string, st: string, now: number) {
      if (st === "idle") { R(mx + mw - 3, my + mh - 2, 1, 1, Math.floor(now / 500) % 2 ? "#173" : "#000"); return; }
      if (st === "done") { X.strokeStyle = "#39d353"; X.lineWidth = 1; X.beginPath(); X.moveTo(mx + 4, my + 4); X.lineTo(mx + 6, my + 6); X.lineTo(mx + 10, my + 2); X.stroke(); return; }
      const t = (now / 700) % 1;
      if (id === "search") { const sx = mx + 1 + t * (mw - 2); R(sx, my + 1, 1, mh - 2, "#39d353"); R(mx + 3, my + 2, 1, 1, "#39d353"); R(mx + 8, my + 4, 1, 1, "#39d353"); }
      else if (id === "filter") { const ok = Math.floor(now / 450) % 2 === 0; X.strokeStyle = ok ? "#39d353" : "#ee1b24"; X.beginPath(); if (ok) { X.moveTo(mx + 4, my + 4); X.lineTo(mx + 6, my + 6); X.lineTo(mx + 10, my + 2); } else { X.moveTo(mx + 5, my + 2); X.lineTo(mx + 9, my + 6); X.moveTo(mx + 9, my + 2); X.lineTo(mx + 5, my + 6); } X.stroke(); }
      else { R(mx + 2, my + 1, mw - 4, 1, "#ee1b24"); const rows = Math.floor(t * 3) + 1; for (let r = 0; r < rows && r < 3; r++) R(mx + 2, my + 3 + r * 2, mw - 4, 1, "#cfcfcf"); }
    }
    function drawDesk(i: number, now: number) {
      const [dx, dy] = DESK[i]; const st = statusRef.current[i];
      R(dx - 24, dy - 10, 48, 24, "#6b4a2e"); R(dx - 24, dy - 10, 48, 2, "#835a36"); R(dx - 24, dy + 12, 48, 2, "#4e3420");
      R(dx - 24, dy - 10, 2, 24, "#5a3f26"); R(dx + 22, dy - 10, 2, 24, "#5a3f26");
      R(dx - 9, dy - 9, 18, 12, "#141414"); const scr = st === "idle" ? "#0a1626" : st === "done" ? "#0c2a14" : "#0a2018";
      R(dx - 7, dy - 7, 14, 8, scr); R(dx - 2, dy + 3, 4, 2, "#0e0e0e");
      drawScreen(dx - 7, dy - 7, 14, 8, AGENTS[i].screen, st, now);
      R(dx - 8, dy + 7, 16, 3, "#4a3a2a"); R(dx + 11, dy + 6, 3, 4, st === "work" ? "#ee1b24" : "#8a5a2a");
      drawWorker(i, now);
    }
    function drawWorker(i: number, now: number) {
      const [sx, sy] = SEAT[i]; const a = AGENTS[i], st = statusRef.current[i]; const work = st === "work";
      const bob = work ? Math.round(Math.sin(now / 160) * 1) : 0; const y = sy + bob;
      // Always show brand shirt colors (even when IDLE) — larger torso so they read clearly.
      const shirt = a.shirt, hair = a.hair;
      R(sx - 8, y - 1, 16, 5, "#3a2a1a"); R(sx - 8, y - 1, 16, 2, "#4e3a28");
      R(sx - 8, y - 10, 16, 10, shirt);
      R(sx - 8, y - 10, 16, 2, shirt);
      const tw = work ? (Math.floor(now / 140) % 2) : 0;
      R(sx - 10, y - 11 + tw, 4, 8, shirt); R(sx + 6, y - 11 + (1 - tw), 4, 8, shirt);
      R(sx - 10, y - 12 + tw, 4, 2, "#f0c090"); R(sx + 6, y - 12 + (1 - tw), 4, 2, "#f0c090");
      R(sx - 6, y - 19, 12, 11, hair);
      if (work) { const p = Math.floor(now / 200) % 2; R(sx - 1, y - 25, 2, 2, p ? "#f0b429" : "#5a4410"); }
      if (st === "done") { X.strokeStyle = "#39d353"; X.lineWidth = 2; X.beginPath(); X.moveTo(sx - 3, y - 24); X.lineTo(sx - 1, y - 22); X.lineTo(sx + 3, y - 27); X.stroke(); X.lineWidth = 1; }
    }
    function drawCourier(dash: Dash, now: number, shirt: string, hair: string, badgeIdx: number | null) {
      if (!dash.visible) return;
      const moving = dash.moving; const f = Math.floor(dash.phase) % 2;
      const bob = moving ? (f ? 0 : (dash.running ? -2 : -1)) : Math.round(Math.sin(now / 500) * 0.5);
      const x = Math.round(dash.x), y = Math.round(dash.y) + bob;
      X.fillStyle = "rgba(0,0,0,0.28)"; X.fillRect(x - 6, y + 1, 12, 2);
      const l1 = moving ? (f ? (dash.running ? 3 : 2) : 0) : 0;
      const l2 = moving ? (f ? 0 : (dash.running ? 3 : 2)) : 0;
      R(x - 4, y - 4 + l1, 3, 4, "#2b2b3a"); R(x + 1, y - 4 + l2, 3, 4, "#2b2b3a");
      R(x - 5, y - 12, 10, 8, shirt); R(x - 5, y - 12, 10, 2, shirt === "#ee1b24" ? "#b3121a" : "#c2410c");
      R(x - 7, y - 11, 2, 6, shirt); R(x + 5, y - 11, 2, 6, shirt);
      if (dash.carry) { R(x - 4, y - 20, 8, 7, "#e8e8e0"); R(x - 4, y - 20, 8, 2, "#39d353"); R(x - 3, y - 16, 6, 1, "#888"); R(x - 3, y - 14, 4, 1, "#888"); }
      const hy = y - 19, skin = "#f0c090";
      R(x - 5, hy, 10, 9, skin);
      if (dash.face === "up") { R(x - 5, hy - 1, 10, 9, hair); }
      else { R(x - 5, hy - 1, 10, 4, hair); R(x - 5, hy, 1, 5, hair); R(x + 4, hy, 1, 5, hair); if (dash.face === "down") { R(x - 3, hy + 4, 2, 2, "#141414"); R(x + 1, hy + 4, 2, 2, "#141414"); } else if (dash.face === "left") { R(x - 3, hy + 4, 2, 2, "#141414"); } else { R(x + 1, hy + 4, 2, 2, "#141414"); } }
      if (dash.running && moving) {
        X.fillStyle = "rgba(255,255,255,0.35)";
        X.fillRect(x - 12, y - 8, 3, 1); X.fillRect(x - 14, y - 5, 4, 1); X.fillRect(x - 11, y - 2, 2, 1);
      }
      if (badgeIdx === 4) {
        const b = badgesRef.current[4];
        if (b) { b.style.left = (dash.x / 320 * 100) + "%"; b.style.top = ((dash.y - 20) / 240 * 100) + "%"; }
      }
    }
    function drawDash(now: number) {
      drawCourier(dashRef.current, now, "#ee1b24", "#141414", 4);
      drawCourier(helperRef.current, now, "#f97316", "#3a2a1a", null);
    }
    function drawMailbox() {
      const [mx, my] = MAILBOX;
      R(mx - 3, my, 3, 10, "#5a3f26");
      R(mx - 9, my - 10, 18, 11, "#b3121a"); R(mx - 9, my - 10, 18, 2, "#ee1b24");
      R(mx - 7, my - 7, 14, 6, "#7a0d10"); R(mx - 2, my - 6, 4, 4, "#39d353");
      R(mx + 8, my - 12, 1, 6, "#5a3f26"); R(mx + 9, my - 12, 4, 3, mailFlashRef.current > 0 ? "#39d353" : "#8a5a2a");
      if (mailFlashRef.current > 0) { R(mx - 4, my - 22, 10, 8, "#0d0d0d"); X.strokeStyle = "#39d353"; X.strokeRect(mx - 4.5, my - 22.5, 11, 9); X.beginPath(); X.moveTo(mx - 1, my - 18); X.lineTo(mx + 1, my - 16); X.lineTo(mx + 4, my - 20); X.stroke(); mailFlashRef.current--; }
    }
    function updateOne(dash: Dash) {
      if (dash.tx === null || dash.ty === null) { dash.moving = false; return; }
      const dx = dash.tx - dash.x, dy = dash.ty - dash.y, d = Math.hypot(dx, dy);
      const sp = dash.speed || 0.9;
      if (d < 1.1) { dash.x = dash.tx; dash.y = dash.ty; dash.tx = null; dash.moving = false; const cb = dash.onArrive; dash.onArrive = null; if (cb) cb(); return; }
      dash.x += dx / d * sp; dash.y += dy / d * sp;
      dash.phase += dash.running ? 0.32 : 0.18;
      dash.moving = true;
      dash.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
    }
    function updateDash() {
      updateOne(dashRef.current);
      updateOne(helperRef.current);
    }

    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      updateDash();
      drawFloor(); drawWalls();
      drawPlant(14, H - 14); drawPlant(W - 14, H - 14);
      drawMailbox();
      for (let i = 0; i < 4; i++) drawDesk(i, now);
      drawDash(now);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- news room canvas (4 desks: SCOUT / PICKER / READER / WRITER) ----
  useEffect(() => {
    const cv = newsCanvasRef.current;
    if (!cv) return;
    const X = cv.getContext("2d")!;
    X.imageSmoothingEnabled = false;
    const W = cv.width, H = cv.height;
    const DESK = [[70, 92], [250, 92], [70, 168], [250, 168]];
    const SEAT = [[70, 126], [250, 126], [70, 202], [250, 202]];
    const R = (x: number, y: number, w: number, h: number, c: string) => { X.fillStyle = c; X.fillRect(Math.round(x), Math.round(y), Math.max(1, w | 0), Math.max(1, h | 0)); };

    newsBadgesRef.current.forEach((b, i) => {
      if (i < 4) { b.style.left = (DESK[i][0] / 320 * 100) + "%"; b.style.top = ((DESK[i][1] - 7) / 240 * 100) + "%"; }
    });

    function drawScreen(mx: number, my: number, mw: number, mh: number, id: string, st: string, now: number) {
      if (st === "idle") { R(mx + mw - 3, my + mh - 2, 1, 1, Math.floor(now / 500) % 2 ? "#173" : "#000"); return; }
      if (st === "done") { X.strokeStyle = "#39d353"; X.lineWidth = 1; X.beginPath(); X.moveTo(mx + 4, my + 4); X.lineTo(mx + 6, my + 6); X.lineTo(mx + 10, my + 2); X.stroke(); return; }
      const t = (now / 700) % 1;
      if (id === "search") { const sx = mx + 1 + t * (mw - 2); R(sx, my + 1, 1, mh - 2, "#39d353"); }
      else if (id === "filter") { const ok = Math.floor(now / 450) % 2 === 0; X.strokeStyle = ok ? "#39d353" : "#ee1b24"; X.beginPath(); if (ok) { X.moveTo(mx + 4, my + 4); X.lineTo(mx + 6, my + 6); X.lineTo(mx + 10, my + 2); } else { X.moveTo(mx + 5, my + 2); X.lineTo(mx + 9, my + 6); X.moveTo(mx + 9, my + 2); X.lineTo(mx + 5, my + 6); } X.stroke(); }
      else { R(mx + 2, my + 1, mw - 4, 1, "#ee1b24"); const rows = Math.floor(t * 3) + 1; for (let r = 0; r < rows && r < 3; r++) R(mx + 2, my + 3 + r * 2, mw - 4, 1, "#cfcfcf"); }
    }
    function drawWorker(i: number, now: number) {
      const [sx, sy] = SEAT[i]; const a = NEWS_AGENTS[i], st = newsStatusRef.current[i] || "idle"; const work = st === "work";
      const bob = work ? Math.round(Math.sin(now / 160) * 1) : 0; const y = sy + bob;
      const shirt = a.shirt, hair = a.hair;
      R(sx - 8, y - 1, 16, 5, "#3a2a1a"); R(sx - 8, y - 10, 16, 10, shirt); R(sx - 8, y - 10, 16, 2, shirt);
      const tw = work ? (Math.floor(now / 140) % 2) : 0;
      R(sx - 10, y - 11 + tw, 4, 8, shirt); R(sx + 6, y - 11 + (1 - tw), 4, 8, shirt);
      R(sx - 6, y - 19, 12, 11, hair);
      if (work) { const p = Math.floor(now / 200) % 2; R(sx - 1, y - 25, 2, 2, p ? "#f0b429" : "#5a4410"); }
    }
    function drawDesk(i: number, now: number) {
      const [dx, dy] = DESK[i]; const st = newsStatusRef.current[i] || "idle";
      R(dx - 24, dy - 10, 48, 24, "#6b4a2e"); R(dx - 24, dy - 10, 48, 2, "#835a36");
      R(dx - 9, dy - 9, 18, 12, "#141414");
      const scr = st === "idle" ? "#0a1626" : st === "done" ? "#0c2a14" : "#0a2018";
      R(dx - 7, dy - 7, 14, 8, scr);
      drawScreen(dx - 7, dy - 7, 14, 8, NEWS_AGENTS[i].screen, st, now);
      drawWorker(i, now);
    }
    function drawParcelOnWriter() {
      if (!writerHasParcelRef.current) return;
      const [dx, dy] = NEWS_WRITER_DESK;
      R(dx + 10, dy - 6, 8, 6, "#e8e8e0");
      R(dx + 10, dy - 6, 8, 2, "#39d353");
      R(dx + 11, dy - 3, 6, 1, "#888");
    }
    function drawPostie(now: number) {
      const p = postieRef.current;
      if (!p.visible) return;
      if (p.tx !== null && p.ty !== null) {
        const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
        const sp = p.running ? 3.6 : 2.2;
        if (d <= sp || d < 1.2) {
          p.x = p.tx; p.y = p.ty; p.tx = null; p.ty = null;
          const cb = p.onArrive; p.onArrive = null; if (cb) cb();
        } else {
          p.x += (dx / d) * sp; p.y += (dy / d) * sp;
          p.phase += p.running ? 0.35 : 0.2;
        }
      }
      const x = Math.round(p.x), y = Math.round(p.y);
      const f = Math.floor(p.phase) % 2;
      const bob = p.tx !== null ? (f ? 0 : (p.running ? -2 : -1)) : 0;
      X.fillStyle = "rgba(0,0,0,0.28)"; X.fillRect(x - 6, y + 1, 12, 2);
      const l1 = p.tx !== null ? (f ? (p.running ? 3 : 2) : 0) : 0;
      const l2 = p.tx !== null ? (f ? 0 : (p.running ? 3 : 2)) : 0;
      R(x - 4, y - 4 + l1 + bob, 3, 4, "#2b2b3a"); R(x + 1, y - 4 + l2 + bob, 3, 4, "#2b2b3a");
      R(x - 5, y - 12 + bob, 10, 8, "#38bdf8"); R(x - 5, y - 12 + bob, 10, 2, "#0284c7");
      if (p.carry) {
        R(x - 4, y - 22 + bob, 8, 7, "#e8e8e0"); R(x - 4, y - 22 + bob, 8, 2, "#39d353");
        R(x - 3, y - 18 + bob, 6, 1, "#888");
      }
      R(x - 5, y - 20 + bob, 10, 8, "#f0c090");
      R(x - 5, y - 21 + bob, 10, 4, "#0c4a6e");
      if (p.running && p.tx !== null) {
        X.fillStyle = "rgba(255,255,255,0.35)";
        X.fillRect(x - 12, y - 8, 3, 1); X.fillRect(x - 14, y - 5, 4, 1);
      }
      X.fillStyle = "rgba(10,7,4,0.92)"; X.fillRect(x - 14, y - 32 + bob, 28, 9);
      X.strokeStyle = "#38bdf8"; X.strokeRect(x - 14.5, y - 32.5 + bob, 29, 10);
      X.fillStyle = "#38bdf8"; X.font = "6px monospace"; X.fillText("POSTIE", x - 11, y - 25 + bob);
    }
    function drawDoorLeft() {
      const open = doorOpenRef.current;
      R(0, 120, 8, 32, "#5f4527");
      R(1, 122, 6, 28, open ? "#1a120a" : "#6b4a2e");
      if (open) { R(1, 122, 2, 28, "#39d353"); R(5, 122, 2, 28, "#39d353"); }
    }
    function drawAisles() {
      // Match THE OFFICE: center aisle + horizontal corridor + desk spurs
      R(140, 52, 40, H - 52, "#a07850");
      for (let y = 52; y < H; y += 8) R(140, y, 40, 1, "#8a6540");
      R(139, 52, 1, H - 52, "#5f4527"); R(180, 52, 1, H - 52, "#5f4527");
      for (let y = 56; y < H - 8; y += 12) R(158, y, 4, 6, "#c9a06a");
      R(0, 128, W, 28, "#a07850");
      for (let x = 0; x < W; x += 10) R(x, 128, 1, 28, "#8a6540");
      R(0, 128, W, 1, "#5f4527"); R(0, 155, W, 1, "#5f4527");
      for (let x = 4; x < W - 4; x += 14) R(x, 140, 8, 2, "#c9a06a");
      R(46, 100, 28, 18, "#946f49"); R(246, 100, 28, 18, "#946f49");
      R(46, 176, 28, 18, "#946f49"); R(246, 176, 28, 18, "#946f49");
    }
    function drawBg() {
      R(0, 0, W, H, "#2e2116");
      R(0, 52, W, H - 52, "#7a5636");
      for (let y = 52; y < H; y += 10) R(0, y, W, 1, "#6b4a2e");
      for (let x = 0; x < W; x += 40) R(x, 52, 1, H - 52, "#6e4d30");
      drawAisles();
      R(0, 0, W, 52, "#1e3a5f");
      R(8, 8, 304, 36, "#152a45");
      X.fillStyle = "#39d353"; X.font = "8px monospace"; X.fillText("RSS · FB · YT · NewsData", 14, 30);
      drawDoorLeft();
    }
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      drawBg();
      for (let i = 0; i < 4; i++) drawDesk(i, now);
      drawParcelOnWriter();
      drawPostie(now);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- courier walk helpers (touch only stable refs) ----
  const walkActor = useCallback(async (
    get: () => { x: number; y: number; tx: number | null; ty: number | null; onArrive: (() => void) | null },
    pts: number[][],
    timeoutMs = 4000,
  ) => {
    for (const [px, py] of pts) {
      await new Promise<void>((res) => {
        const a = get();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          a.x = px; a.y = py; a.tx = null; a.ty = null; a.onArrive = null;
          res();
        };
        a.tx = px; a.ty = py;
        a.onArrive = finish;
        setTimeout(finish, timeoutMs);
      });
    }
  }, []);

  const walkPostie = useCallback(
    (pts: number[][]) => walkActor(() => postieRef.current, pts, 3500),
    [walkActor],
  );

  const setDoorOpen = useCallback((open: boolean) => {
    doorOpenRef.current = open;
    if (doorElRef.current) doorElRef.current.classList.toggle("open", open);
  }, []);

  const hidePostie = useCallback(() => {
    const p = postieRef.current;
    p.visible = false;
    p.carry = false;
    p.running = false;
    p.tx = null;
    p.ty = null;
    p.onArrive = null;
    p.x = NEWS_AISLE_X;
    p.y = 150;
    setDoorOpen(false);
  }, [setDoorOpen]);

  const walkPath = useCallback(async (pts: number[][], who: "dash" | "helper" = "dash") => {
    await walkActor(
      () => (who === "helper" ? helperRef.current : dashRef.current),
      pts,
      4500,
    );
  }, [walkActor]);

  const setDashPace = useCallback((d: Dash, run: boolean) => {
    d.running = run;
    d.speed = run ? 2.5 : 0.9;
  }, []);

  const isBackendFast = useCallback((atIso?: string) => {
    const start = traceStartedAtRef.current;
    if (!start) return false;
    const t = atIso ? new Date(atIso).getTime() : Date.now();
    return Number.isFinite(t) && t - start < 7000;
  }, []);

  const courierReply = useCallback(async (intent: string, atIso?: string) => {
    setAgent(4, "work");
    const backlog = queueRef.current.length >= 1;
    const run = isBackendFast(atIso);
    setDashPace(dashRef.current, run);
    const verb = run ? "วิ่ง" : "เดิน";
    const isNewsJob = newsJobRef.current || mailHasParcelRef.current || /news|ข่าว|get_news/i.test(intent);

    // News → always from mailbox along the aisle. Never walk to BRAIN / office desks.
    if (isNewsJob) {
      hidePostie();
      setCap(`<b>DASH</b> (REPLY) — ${verb}ตามทางเดินส่งข่าวจากตู้จดหมาย`);
      log(`  DASH ${verb}ตามทางเดิน → ตู้จดหมาย → LINE`, "a");
      await walkPath([
        [OFFICE_AISLE_X, 150],
        [OFFICE_MAIL[0], OFFICE_MAIL[1]],
      ]);
      mailFlashRef.current = 60;
      mailHasParcelRef.current = false;
      newsJobRef.current = false;
      dashRef.current.carry = false;
      log(`  ส่งคำตอบกลับแล้ว ✓ (${intent})`, "g");
      if (backlog) {
        const h = helperRef.current;
        h.visible = true; h.x = 200; h.y = 120; h.carry = true;
        setDashPace(h, true);
        log("  HOP ช่วยวิ่งส่งงานคิวถัดไปตามทางเดิน", "a");
        void walkPath([[OFFICE_AISLE_X, 130], [OFFICE_MAIL[0], OFFICE_MAIL[1]], [200, 120]], "helper").then(() => {
          h.carry = false; h.visible = false; h.running = false; h.speed = 1.1;
        });
      }
      await sleep(run ? 200 : 400);
      await walkPath([[OFFICE_AISLE_X, 150]]);
      setDashPace(dashRef.current, false);
      setAgent(4, "done");
      return;
    }

    setCap(`<b>DASH</b> (REPLY) — ${verb}ตามทางเดินเอาคำตอบไปส่ง`);
    let last = 3;
    for (let i = 3; i >= 0; i--) {
      if (statusRef.current[i] === "done" || statusRef.current[i] === "work") { last = i; break; }
    }
    const left = last % 2 === 0;
    const sideX = left ? 102 : 218;
    const ay = last < 2 ? 108 : 178;

    if (backlog) {
      const h = helperRef.current;
      h.visible = true; h.x = 200; h.y = 120; h.carry = false;
      setDashPace(h, run);
      log("  HOP มาช่วยส่งงานซ้อนตามทางเดิน", "a");
      void (async () => {
        await walkPath([[OFFICE_AISLE_X, ay], [left ? 218 : 102, ay]], "helper");
        h.carry = true;
        await walkPath([[OFFICE_AISLE_X, ay], [OFFICE_MAIL[0], OFFICE_MAIL[1]]], "helper");
        h.carry = false;
        mailFlashRef.current = 40;
        await walkPath([[OFFICE_AISLE_X, 120]], "helper");
        h.visible = false; h.running = false; h.speed = 1.1;
      })();
    }

    // Aisle → spur to desk → aisle → mailbox
    await walkPath([[OFFICE_AISLE_X, ay], [sideX, ay]]);
    dashRef.current.carry = true;
    await sleep(run ? 80 : 200);
    await walkPath([[OFFICE_AISLE_X, ay], [OFFICE_MAIL[0], OFFICE_MAIL[1]]]);
    dashRef.current.carry = false;
    mailFlashRef.current = 60;
    log(`  ส่งคำตอบกลับแล้ว ✓ (${intent})`, "g");
    await sleep(run ? 200 : 400);
    await walkPath([[OFFICE_AISLE_X, 150]]);
    setDashPace(dashRef.current, false);
    setAgent(4, "done");
  }, [hidePostie, isBackendFast, log, setAgent, setCap, setDashPace, walkPath]);

  const deliverNewsCourier = useCallback(async () => {
    const p = postieRef.current;
    newsJobRef.current = true;
    writerHasParcelRef.current = true;
    p.visible = true;
    p.carry = false;
    p.running = false;
    p.phase = 0;
    p.x = NEWS_AISLE_X;
    p.y = 150;
    p.tx = null;
    p.ty = null;
    p.onArrive = null;
    setDoorOpen(true);
    try {
      if (newsCapRef.current) newsCapRef.current.innerHTML = "<b>POSTIE</b> — เดินตามทางไปโต๊ะ WRITER…";
      log("  POSTIE เดินตามทางเดิน → โต๊ะ WRITER", "a");
      await walkPostie([
        [NEWS_AISLE_X, 190],
        [NEWS_WRITER_PICKUP[0], NEWS_WRITER_PICKUP[1]],
      ]);
      await sleep(200);
      writerHasParcelRef.current = false;
      p.carry = true;
      p.running = true;
      log("  POSTIE วิ่งตามทางเดินไปประตู", "a");
      if (newsCapRef.current) newsCapRef.current.innerHTML = "<b>POSTIE</b> — วิ่งตามทางเดินไปประตู…";
      await walkPostie([
        [NEWS_AISLE_X, 190],
        [NEWS_AISLE_X, 140],
        [NEWS_DOOR[0], NEWS_DOOR[1]],
      ]);

      // Hand off now — hide POSTIE immediately so it never stays stuck waiting.
      p.carry = false;
      hidePostie();
      mailHasParcelRef.current = true;

      setAgent(4, "work");
      setDashPace(dashRef.current, true);
      setCap("<b>DASH</b> — วิ่งตามทางเดินรับข่าว → ตู้จดหมาย");
      log("  DASH รับข่าวที่ประตู แล้ววิ่งไปตู้จดหมาย", "a");
      dashRef.current.carry = true;
      await walkPath([
        [OFFICE_AISLE_X, 150],
        [OFFICE_AISLE_X, 140],
        [OFFICE_DOOR[0], OFFICE_DOOR[1]],
        [OFFICE_AISLE_X, 140],
        [OFFICE_MAIL[0], OFFICE_MAIL[1]],
      ]);
      dashRef.current.carry = false;
      mailFlashRef.current = 60;
      log("  DASH ใส่ข่าวในตู้จดหมาย ✓", "g");
      if (capRef.current) capRef.current.innerHTML = "<b>ตู้จดหมาย</b> — ได้สรุปข่าวแล้ว · รอส่ง LINE";
      await walkPath([[OFFICE_AISLE_X, 150]]);
      setDashPace(dashRef.current, false);
      setAgent(4, "idle");
    } finally {
      hidePostie();
      writerHasParcelRef.current = false;
    }
  }, [hidePostie, log, setAgent, setCap, setDashPace, setDoorOpen, walkPath, walkPostie]);

  // ---- play one trace's events in sequence ----
  const resetRoom = useCallback(() => {
    AGENTS.forEach((_, i) => setAgent(i, "idle"));
    const d = dashRef.current;
    d.x = 160; d.y = 150; d.tx = null; d.ty = null; d.carry = false; d.face = "down";
    d.speed = 0.9; d.running = false; d.visible = true;
    const h = helperRef.current;
    h.visible = false; h.tx = null; h.ty = null; h.carry = false; h.running = false; h.speed = 1.1;
    mailHasParcelRef.current = false;
  }, [setAgent]);

  const applyEvent = useCallback(async (e: MonEvent) => {
    // new trace → fresh room
    if (e.traceId !== curTraceRef.current) {
      curTraceRef.current = e.traceId;
      resetRoom();
      resetNewsRoom();
      traceStartedAtRef.current = e.at ? new Date(e.at).getTime() : Date.now();
      // Placeholder: keep the internal "last LLM used" state,
      // but hide the visible "LLM —" until we actually parse a label.
      lastLlmRef.current = "—";
      setLlmLabel("");
      setLlmHot(false);
      log(`> คำขอใหม่จาก ${e.user} (${e.channel})`, "b");
      setHud("WORKING", "var(--amber)");
    }

    const llmFromLabel = parseLlm(e.label);
    const isNews = /📰/.test(e.label || "");
    if (isNews) {
      newsJobRef.current = true;
      // Park OFFICE desks (esp. green BRAIN) — news work belongs in NEWS ROOM.
      for (let i = 0; i < 4; i++) {
        if (statusRef.current[i] === "work" || statusRef.current[i] === "done") setAgent(i, "idle");
      }
    }
    updateNewsRoom(e);

    // Hand off once when summary is ready
    if (!newsDeliveredRef.current && /📰 สรุปเสร็จ|📰 สรุปข่าวภาษาไทย|📰 ได้ข่าว/.test(e.label || "")) {
      newsDeliveredRef.current = true;
      writerHasParcelRef.current = true;
      await deliverNewsCourier();
    }

    if (llmFromLabel) {
      if (llmFromLabel.startsWith("NONE")) {
        setLlmHud("NONE · กฎ", false);
        log(`  ★ AI: ไม่ใช้ LLM (กฎตายตัว)`, "a");
      } else if (e.status === "error" || /✗/.test(e.label)) {
        setLlmHud(`${llmFromLabel} ✗`, false);
        log(`  ★ AI: ${llmFromLabel} ล้มเหลว`, "r");
      } else if (e.status === "start" || /fallback/i.test(e.label)) {
        setLlmHud(llmFromLabel, true);
        log(`  ★ AI: กำลังใช้ ${llmFromLabel}`, "a");
      } else {
        setLlmHud(llmFromLabel, false);
        log(`  ★ AI: ${llmFromLabel}`, "g");
      }
    }

    const step = e.step as StageId | "error";
    if (step === "error") {
      const i = STEP_TO_INDEX[(e.label.split(" ")[0] as StageId)] ?? 4;
      setAgent(i, "idle");
      setHud("ERROR", "var(--red)");
      log(`  ! ${e.label}`, "r");
      return;
    }
    const idx = STEP_TO_INDEX[step];
    if (idx === undefined) return;

    if (step === "reply") {
      const intent = e.label.replace(/^ตอบกลับ\s*/, "").replace(/[()]/g, "");
      const isNewsReply = newsJobRef.current || isNews || /news|ข่าว|get_news/i.test(intent);
      for (let i = 0; i < 4; i++) if (statusRef.current[i] === "work") setAgent(i, "done");
      await courierReply(intent, e.at);
      setHud("DELIVERED", "var(--green)");
      const used = lastLlmRef.current;
      const aiBit =
        !used || used === "—"
          ? " · AI: ไม่ได้เรียกในรอบนี้"
          : used.startsWith("NONE")
            ? " · AI: ไม่ใช้ LLM"
            : ` · AI: ${used}`;
      setLlmHud(used === "—" ? "NONE · รอบนี้" : used, false);
      setCap(`<b>เสร็จ</b> — ส่งคำตอบให้ ${e.user} แล้ว${aiBit}`);
      log(`  ★ สรุป AI รอบนี้: ${used === "—" ? "ไม่ได้เรียก LLM" : used}`, used.startsWith("NONE") || used === "—" ? "t" : "g");
      // After LINE reply: clear SCOUT (เขียวอ่อน) / news desks so nobody stays WORKING.
      // If digest is still running in background, later 📰 events will light them again.
      if (isNewsReply) {
        for (let i = 0; i < 4; i++) setAgent(i, "idle");
        setAgent(4, "idle");
        idleNewsDesks();
        if (newsDeliveredRef.current) newsJobRef.current = false;
      } else {
        await sleep(800);
        for (let i = 0; i < 5; i++) setAgent(i, "idle");
      }
      return;
    }

    // News pipeline uses fetch/compose steps but must NOT light OFFICE RUNNER (M365).
    if (isNews) {
      log(`  NEWS: ${e.label}`, e.status === "start" ? "a" : "g");
      await sleep(e.status === "start" ? 140 : step === "fetch" ? 100 : 220);
      return;
    }

    // receive / parse / fetch / compose — THE OFFICE only
    const a = AGENTS[idx];
    if (e.status === "start") {
      setAgent(idx, "work");
      const capExtra = llmFromLabel ? ` · <b style="color:#f0b429">${llmFromLabel}</b>` : "";
      setCap(`<b>${a.name}</b> (${a.role}) — ${a.cap}${capExtra}`);
      log(`[${a.name}] ${e.label}`, "a");
      await sleep(220);
    } else {
      setAgent(idx, "work");
      const capExtra = llmFromLabel ? ` · <b style="color:#f0b429">${llmFromLabel}</b>` : "";
      setCap(`<b>${a.name}</b> (${a.role}) — ${a.cap}${capExtra}`);
      log(`  ${a.role}: ${e.label}`, step === "fetch" ? "t" : "g");
      await sleep(step === "fetch" ? 160 : 360);
      setAgent(idx, "done");
    }
  }, [courierReply, deliverNewsCourier, idleNewsDesks, log, resetNewsRoom, resetRoom, setAgent, setCap, setHud, setLlmHud, updateNewsRoom]);

  // ---- player: drains the queue in order with animation timing ----
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      if (!busyRef.current && queueRef.current.length) {
        busyRef.current = true;
        const e = queueRef.current.shift()!;
        try { await applyEvent(e); } catch { /* ignore */ }
        busyRef.current = false;
      }
      if (alive) setTimeout(tick, 60);
    };
    tick();
    return () => { alive = false; };
  }, [applyEvent]);

  // ---- poller: fetch new events, enqueue ----
  useEffect(() => {
    // Prod needs a signed-in account; local dev polls open (no token).
    if (!DEV && !account) return;
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      try {
        const token = await getToken();
        if (token || DEV) {
          const headers: Record<string, string> = {};
          if (token) headers.Authorization = `Bearer ${token}`;
          const r = await fetch(`/api/monitor/events?since=${cursorRef.current}`, {
            headers,
            cache: "no-store",
          });
          if (r.ok) {
            const d = await r.json();
            if (d.llm?.ready?.length) {
              const chain = d.llm.ready
                .map((p: { id: string; model: string; keyEnv: string }) => `${p.id.toUpperCase()}(${p.keyEnv})`)
                .join(" → ");
              setLlmChain(chain);
              if (lastLlmRef.current === "—" && d.llm.ready[0]) {
                const first = d.llm.ready[0];
                setLlmHud(`${first.id.toUpperCase()} · ${first.model}`, false);
              }
            }
            // Setup not done yet (table missing) → tell the user instead of a blank room.
            if (d.note && capRef.current && !queueRef.current.length) {
              capRef.current.innerHTML = '<b style="color:#f0b429">ยังไม่พร้อม</b> — รัน supabase/migration_agent_traces.sql ใน Supabase ก่อน แล้วรีเฟรช';
            }
            // First response: seed cursor only — F5 must not replay old jobs as if live.
            if (!primedRef.current) {
              primedRef.current = true;
              if (typeof d.cursor === "number") cursorRef.current = d.cursor;
              setHud("IDLE", "var(--dim)");
              if (capRef.current) {
                const chainNote = d.llm?.ready?.length
                  ? ` · API: ${d.llm.ready.map((p: { id: string }) => p.id.toUpperCase()).join(" → ")}`
                  : "";
                capRef.current.innerHTML = `<b>พร้อม</b> — รอคำขอใหม่จาก LINE / Web${chainNote}`;
              }
            } else if (Array.isArray(d.events) && d.events.length) {
              if (queueRef.current.length < 400) {
                // Dedupe: avoid the same agent_traces row being enqueued/logged twice
                // (can happen when /monitor is refreshed while the queue drains).
                for (const ev of d.events as MonEvent[]) {
                  if (seenEventIdsRef.current.size > 10000) seenEventIdsRef.current.clear();
                  if (seenEventIdsRef.current.has(ev.id)) continue;
                  if (queueRef.current.length >= 400) break;
                  seenEventIdsRef.current.add(ev.id);
                  queueRef.current.push(ev);
                }
              }
              cursorRef.current = d.cursor || cursorRef.current;
            } else if (typeof d.cursor === "number") {
              cursorRef.current = d.cursor;
            }
          }
        }
      } catch { /* transient */ }
      if (alive) setTimeout(poll, 1500);
    };
    poll();
    return () => { alive = false; };
  }, [account, getToken]);

  const newsLive = newsScoutStatus !== "idle" || newsPicker.status !== "idle" || newsWriter.status !== "idle";

  return (
    <div className="mon">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <header>
          <svg className="mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <g stroke="#ee1b24" strokeWidth="17"><line x1="24" y1="20" x2="82" y2="86" /><line x1="22" y1="86" x2="74" y2="28" /></g>
            <polygon points="89,11 63.6,18.7 84.4,37.3" fill="#ee1b24" />
          </svg>
          <div>
            <h1 className="pix">AI ASSISTANT · <em>AGENT ROOM</em></h1>
          </div>
          <div className="spacer" />
          <div className="badges">
            <div className={`badge llm${llmHot ? " hot" : ""}`} title={llmChain || "AI API provider"}>
              LLM <b>{llmLabel}</b>
            </div>
            <div className="badge">STATUS <b ref={(el) => { hudRef.current = el; }}>{status}</b></div>
          </div>
        </header>

        <div className="panel building">
          <div className="ph building-ph">
            <span className="room-tag">
              <span>THE OFFICE</span>
              <span className="live">● LIVE</span>
            </span>
            <span className="wall-bar" aria-hidden="true" />
            <span className="room-tag">
              <span>NEWS ROOM · สรุปข่าว</span>
              <span className="live">● {newsLive ? "LIVE" : "IDLE"}</span>
            </span>
          </div>
          <div className="building-stage">
            <div className="building-wing office-wing">
              <div className="room-frame">
                <canvas id="room" ref={canvasRef} width={320} height={240} />
                {AGENTS.map((a, i) => (
                  <div
                    key={a.id}
                    className="bdg idle"
                    ref={(el) => { if (el) badgesRef.current[i] = el; }}
                  >
                    <span className="nm">{a.name}</span>
                    <span className="stt"><span className="dot" /><span className="w">IDLE</span></span>
                  </div>
                ))}
              </div>
              <div className="wing-cap" ref={capRef}>รอคำขอเข้ามา… (LINE / Web)</div>
            </div>
            <div className="building-wall" aria-hidden="true">
              <div className="door" ref={doorElRef} title="ประตูเชื่อม NEWS ROOM → THE OFFICE" />
            </div>
            <div className="building-wing news-wing">
              <div className="room-frame">
                <canvas id="news-room" ref={newsCanvasRef} width={320} height={240} />
                {NEWS_AGENTS.map((a, i) => (
                  <div
                    key={a.id}
                    className="bdg idle"
                    ref={(el) => { if (el) newsBadgesRef.current[i] = el; }}
                  >
                    <span className="nm">{a.name}</span>
                    <span className="stt"><span className="dot" /><span className="w">IDLE</span></span>
                  </div>
                ))}
              </div>
              <div className="wing-cap" ref={newsCapRef}>รอคำขอ “ข่าววันนี้”…</div>
            </div>
          </div>
          <div className="news-grid">
            <div className={`news-desk scout ${newsScoutStatus}`}>
              <div className="hd">
                <span className="nm">SCOUT · ดึงแหล่ง</span>
                <span className="st">{newsScoutStatus === "work" ? "WORKING" : newsScoutStatus === "done" ? "DONE" : newsScoutStatus === "error" ? "ERROR" : "IDLE"}</span>
              </div>
              <ul>
                {newsSources.length ? newsSources.map((s) => (
                  <li key={s.key} className={s.status}>{s.text}</li>
                )) : (
                  <li className="k">RSS · Facebook · YouTube · NewsData</li>
                )}
              </ul>
            </div>
            <div className={`news-desk picker ${newsPicker.status}`}>
              <div className="hd">
                <span className="nm">PICKER · AI เลือกเด่น</span>
                <span className="st">{newsPicker.status === "work" ? "WORKING" : newsPicker.status === "done" ? "DONE" : newsPicker.status === "error" ? "ERROR" : "IDLE"}</span>
              </div>
              <div className="ai">{newsPicker.ai}</div>
              <div className="cap">{newsPicker.detail}</div>
            </div>
            <div className={`news-desk reader ${newsReader.status}`}>
              <div className="hd">
                <span className="nm">READER · อ่านบทความ</span>
                <span className="st">{newsReader.status === "work" ? "WORKING" : newsReader.status === "done" ? "DONE" : newsReader.status === "error" ? "ERROR" : "IDLE"}</span>
              </div>
              <div className="ai">{newsReader.ai}</div>
              <div className="cap">{newsReader.detail}</div>
            </div>
            <div className={`news-desk writer ${newsWriter.status}`}>
              <div className="hd">
                <span className="nm">WRITER · AI สรุปประเด็น</span>
                <span className="st">{newsWriter.status === "work" ? "WORKING" : newsWriter.status === "done" ? "DONE" : newsWriter.status === "error" ? "ERROR" : "IDLE"}</span>
              </div>
              <div className="ai">{newsWriter.ai}</div>
              <div className="cap">{newsWriter.detail}</div>
            </div>
          </div>
        </div>

        <div className="cols">
          <div className="panel"><div className="ph"><span>CONSOLE</span></div><div id="log" ref={logRef} /></div>
          <div className="panel">
            <div className="ph"><span>STAGES</span></div>
            <div id="legend">
              <div className="leg-col">
                <div className="leg-h">THE OFFICE</div>
                {AGENTS.map((a) => (
                  <div className="row" key={a.id}>
                    <span className="sw" style={{ background: a.shirt }} />
                    <span><span className="rl">{a.name}</span> <span className="rc">— {a.role}</span></span>
                  </div>
                ))}
                <div className="row">
                  <span className="sw" style={{ background: "#f97316" }} />
                  <span><span className="rl">HOP</span> <span className="rc">— ช่วยส่งคิวซ้อน</span></span>
                </div>
              </div>
              <div className="leg-col">
                <div className="leg-h">NEWS ROOM</div>
                {NEWS_AGENTS.map((a) => (
                  <div className="row" key={a.id}>
                    <span className="sw" style={{ background: a.shirt }} />
                    <span><span className="rl">{a.name}</span> <span className="rc">— {a.role}</span></span>
                  </div>
                ))}
                <div className="row">
                  <span className="sw" style={{ background: "#38bdf8" }} />
                  <span><span className="rl">POSTIE</span> <span className="rc">— วิ่งส่งข่าว</span></span>
                </div>
              </div>
              {llmChain ? (
                <div className="row span2">
                  <span className="sw" style={{ background: "#f0b429" }} />
                  <span>
                    <span className="rl">LLM</span>{" "}
                    <span className="rc">— {llmChain}</span>
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="foot pix">KTIS · AI ASSISTANT LIVE MONITOR</div>
      </div>
    </div>
  );
}

function Gate() {
  const { account, login, ready, getToken } = useM365Auth();
  // Local dev: skip login entirely so the room is watchable while working.
  if (DEV) return <MonitorRoom getToken={getToken} account={account ?? "dev"} />;
  if (!ready) {
    return <div className="mon"><style dangerouslySetInnerHTML={{ __html: CSS }} /><div className="center pix" style={{ fontSize: 12 }}>กำลังโหลด…</div></div>;
  }
  if (!account) {
    return (
      <div className="mon">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="pix" style={{ fontSize: 14, color: "#ee1b24" }}>AI ASSISTANT · MONITOR</div>
          <div style={{ fontSize: 20, color: "#7c7c7c" }}>ต้องล็อกอิน Microsoft 365 เพื่อดูหน้านี้</div>
          <button className="btn" onClick={() => login()}>เข้าสู่ระบบ M365</button>
        </div>
      </div>
    );
  }
  return <MonitorRoom getToken={getToken} account={account} />;
}

export default function MonitorPage() {
  return (
    <M365AuthProvider>
      <Gate />
    </M365AuthProvider>
  );
}
