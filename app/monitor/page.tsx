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
  { id: "courier", name: "DASH", role: "REPLY", cap: "เดินเอาคำตอบไปส่งกลับ", shirt: "#ee1b24", hair: "#141414", screen: "" },
] as const;

const STEP_TO_INDEX: Record<StageId, number> = { receive: 0, parse: 1, fetch: 2, compose: 3, reply: 4 };

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap');
.mon{--bg:#0a0a0a;--panel:#121212;--panel2:#171717;--ink:#f5f5f5;--dim:#7c7c7c;--red:#ee1b24;--green:#39d353;--amber:#f0b429;--hair:#262626;background:var(--bg);color:var(--ink);font-family:'VT323',monospace;min-height:100vh;padding:18px;position:relative;overflow-x:hidden}
.mon *{margin:0;padding:0;box-sizing:border-box}
.mon::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:60;background:repeating-linear-gradient(0deg,rgba(0,0,0,0.14) 0 1px,transparent 1px 3px);mix-blend-mode:multiply}
.mon .pix{font-family:'Press Start 2P',monospace}
.mon .wrap{max-width:1160px;margin:0 auto}
.mon header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;border:2px solid var(--hair);background:var(--panel);padding:14px 16px;margin-bottom:12px}
.mon header .mark{width:34px;height:34px;flex:none}
.mon header h1{font-size:15px;line-height:1.4}.mon header h1 em{color:var(--red);font-style:normal}
.mon header .tag{font-size:19px;color:var(--dim);margin-top:2px}
.mon header .spacer{flex:1}
.mon .badge{font-size:16px;color:var(--dim);border:1px solid var(--hair);padding:3px 8px}.mon .badge b{color:var(--green)}
.mon .badge.llm b{color:var(--amber)}
.mon .badge.llm.hot b{color:#fff;animation:monpulse .7s steps(1) infinite}
.mon .badges{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mon .panel{border:2px solid var(--hair);background:var(--panel);margin-bottom:12px}
.mon .ph{font-family:'Press Start 2P';font-size:9px;color:var(--dim);padding:9px 11px;border-bottom:2px solid var(--hair);background:var(--panel2);display:flex;justify-content:space-between}
.mon .ph .live{color:var(--red)}
.mon .room-stage{background:#1a120a;padding:10px;display:flex;justify-content:center}
.mon .room-frame{position:relative;width:100%;max-width:760px}
.mon #room{width:100%;display:block;image-rendering:pixelated;border:2px solid #3a2a1a;background:#2e2116}
.mon .bdg{position:absolute;transform:translate(-50%,-100%);text-align:center;pointer-events:none;background:rgba(10,7,4,.92);border:2px solid var(--hair);padding:2px 4px 1px;white-space:nowrap;line-height:1;transition:left .05s linear,top .05s linear;z-index:2}
.mon .bdg .nm{font-family:'Press Start 2P';font-size:6px;color:var(--ink);display:block;margin-bottom:2px}
.mon .bdg .stt{font-family:'Press Start 2P';font-size:6px}
.mon .bdg .dot{display:inline-block;width:4px;height:4px;margin-right:3px;vertical-align:middle;background:var(--dim)}
.mon .bdg.idle .stt{color:var(--dim)}.mon .bdg.idle .dot{background:var(--dim)}
.mon .bdg.work{border-color:var(--amber)}.mon .bdg.work .stt{color:var(--amber)}.mon .bdg.work .dot{background:var(--amber);animation:monpulse .55s steps(1) infinite}
.mon .bdg.done{border-color:var(--green)}.mon .bdg.done .stt{color:var(--green)}.mon .bdg.done .dot{background:var(--green)}
@keyframes monpulse{50%{opacity:.2}}
.mon .caption{font-size:19px;color:var(--dim);text-align:center;padding:9px}.mon .caption b{color:var(--red)}
.mon .cols{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;align-items:stretch}
@media(max-width:900px){.mon .cols{grid-template-columns:minmax(0,1fr)}}
.mon .cols > .panel{min-width:0;max-width:100%;overflow:hidden}
.mon #log{height:220px;overflow-x:hidden;overflow-y:auto;font-size:18px;line-height:1.18;padding:10px;min-width:0}
.mon #log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.mon #log .t{color:var(--dim)}.mon #log .g{color:var(--green)}.mon #log .r{color:var(--red)}.mon #log .a{color:var(--amber)}.mon #log .b{color:#3a86ff}
.mon #legend{padding:12px;min-height:220px;font-size:18px;line-height:1.5;min-width:0}
.mon #legend .row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.mon #legend .sw{width:12px;height:12px;flex:none;border:1px solid #000}
.mon #legend .rl{font-family:'Press Start 2P';font-size:7px;color:var(--ink)}
.mon #legend .rc{color:var(--dim);font-size:16px}
.mon .foot{font-family:'Press Start 2P';font-size:8px;color:#3a3a3a;text-align:center;margin-top:12px;padding:6px}
.mon .btn{font-family:'Press Start 2P';font-size:10px;background:var(--ink);color:#000;border:2px solid var(--ink);padding:10px 16px;cursor:pointer}
.mon .center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:60vh;text-align:center}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Online (Vercel build) → NODE_ENV=production → M365 login required.
// Local `next dev` → development → open, no login (watch the room while working).
const DEV = process.env.NODE_ENV !== "production";

// ----- canvas art (ported, trimmed) -----
type Dash = { x: number; y: number; tx: number | null; ty: number | null; face: string; moving: boolean; phase: number; carry: boolean; onArrive: (() => void) | null };

function MonitorRoom({ getToken, account }: { getToken: () => Promise<string | null>; account: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const capRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLElement | null>(null);
  const llmHudRef = useRef<HTMLElement | null>(null);
  const badgesRef = useRef<HTMLDivElement[]>([]);

  const statusRef = useRef<string[]>(AGENTS.map(() => "idle"));
  const dashRef = useRef<Dash>({ x: 160, y: 150, tx: null, ty: null, face: "down", moving: false, phase: 0, carry: false, onArrive: null });
  const mailFlashRef = useRef(0);

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

    function drawFloor() {
      R(0, 52, W, H - 52, "#7a5636");
      for (let y = 52; y < H; y += 10) R(0, y, W, 1, "#6b4a2e");
      for (let x = 0; x < W; x += 40) R(x, 52, 1, H - 52, "#6e4d30");
      R(140, 52, 40, H - 52, "#946f49");
      for (let y = 52; y < H; y += 10) R(140, y, 40, 1, "#845f3d");
      R(139, 52, 1, H - 52, "#5f4527"); R(180, 52, 1, H - 52, "#5f4527");
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
    function drawDash(now: number) {
      const dash = dashRef.current; const st = statusRef.current[4];
      const moving = dash.moving; const f = Math.floor(dash.phase) % 2;
      const bob = moving ? (f ? 0 : -1) : Math.round(Math.sin(now / 500) * 0.5);
      const x = Math.round(dash.x), y = Math.round(dash.y) + bob;
      X.fillStyle = "rgba(0,0,0,0.28)"; X.fillRect(x - 6, y + 1, 12, 2);
      const l1 = moving ? (f ? 2 : 0) : 0, l2 = moving ? (f ? 0 : 2) : 0;
      R(x - 4, y - 4 + l1, 3, 4, "#2b2b3a"); R(x + 1, y - 4 + l2, 3, 4, "#2b2b3a");
      R(x - 5, y - 12, 10, 8, "#ee1b24"); R(x - 5, y - 12, 10, 2, "#b3121a");
      R(x - 7, y - 11, 2, 6, "#ee1b24"); R(x + 5, y - 11, 2, 6, "#ee1b24");
      if (dash.carry) { R(x - 4, y - 20, 8, 7, "#e8e8e0"); R(x - 4, y - 20, 8, 2, "#39d353"); R(x - 3, y - 16, 6, 1, "#888"); R(x - 3, y - 14, 4, 1, "#888"); }
      const hy = y - 19, skin = "#f0c090", hair = "#141414";
      R(x - 5, hy, 10, 9, skin);
      if (dash.face === "up") { R(x - 5, hy - 1, 10, 9, hair); }
      else { R(x - 5, hy - 1, 10, 4, hair); R(x - 5, hy, 1, 5, hair); R(x + 4, hy, 1, 5, hair); if (dash.face === "down") { R(x - 3, hy + 4, 2, 2, "#141414"); R(x + 1, hy + 4, 2, 2, "#141414"); } else if (dash.face === "left") { R(x - 3, hy + 4, 2, 2, "#141414"); } else { R(x + 1, hy + 4, 2, 2, "#141414"); } }
      if (st === "work" && !dash.carry) { const p = Math.floor(now / 180) % 2; R(x + 6, y - 22, 1, 1, p ? "#fff" : "#000"); }
      // Courier badge rides on the character's head and moves with it every frame.
      const b = badgesRef.current[4]; if (b) { b.style.left = (dash.x / 320 * 100) + "%"; b.style.top = ((dash.y - 20) / 240 * 100) + "%"; }
    }
    function drawMailbox() {
      const [mx, my] = MAILBOX;
      R(mx - 3, my, 3, 10, "#5a3f26");
      R(mx - 9, my - 10, 18, 11, "#b3121a"); R(mx - 9, my - 10, 18, 2, "#ee1b24");
      R(mx - 7, my - 7, 14, 6, "#7a0d10"); R(mx - 2, my - 6, 4, 4, "#39d353");
      R(mx + 8, my - 12, 1, 6, "#5a3f26"); R(mx + 9, my - 12, 4, 3, mailFlashRef.current > 0 ? "#39d353" : "#8a5a2a");
      if (mailFlashRef.current > 0) { R(mx - 4, my - 22, 10, 8, "#0d0d0d"); X.strokeStyle = "#39d353"; X.strokeRect(mx - 4.5, my - 22.5, 11, 9); X.beginPath(); X.moveTo(mx - 1, my - 18); X.lineTo(mx + 1, my - 16); X.lineTo(mx + 4, my - 20); X.stroke(); mailFlashRef.current--; }
    }
    function updateDash() {
      const dash = dashRef.current;
      if (dash.tx === null || dash.ty === null) { dash.moving = false; return; }
      const dx = dash.tx - dash.x, dy = dash.ty - dash.y, d = Math.hypot(dx, dy), sp = 0.9;
      if (d < 1.1) { dash.x = dash.tx; dash.y = dash.ty; dash.tx = null; dash.moving = false; const cb = dash.onArrive; dash.onArrive = null; if (cb) cb(); return; }
      dash.x += dx / d * sp; dash.y += dy / d * sp; dash.phase += 0.18; dash.moving = true;
      dash.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
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

  // ---- courier walk helpers (touch only stable refs) ----
  const walkPath = useCallback(async (pts: number[][]) => {
    for (const [px, py] of pts) {
      await new Promise<void>((res) => { const d = dashRef.current; d.tx = px; d.ty = py; d.onArrive = res; });
    }
  }, []);

  const courierReply = useCallback(async (intent: string) => {
    setAgent(4, "work");
    setCap(`<b>DASH</b> (REPLY) — เดินเอาคำตอบไปส่งกลับผู้ใช้`);
    // Pick up from the last desk that finished — stand beside it (aisle side),
    // never walk through the desk body (desk spans dx±24).
    let last = 3;
    for (let i = 3; i >= 0; i--) {
      if (statusRef.current[i] === "done" || statusRef.current[i] === "work") { last = i; break; }
    }
    const left = last % 2 === 0;
    const sideX = left ? 102 : 218;
    const ay = last < 2 ? 108 : 178;
    // Aisle → beside last working PC → pick up → aisle → mailbox.
    await walkPath([[160, ay], [sideX, ay]]);
    dashRef.current.carry = true;
    await sleep(250);
    await walkPath([[160, ay], [160, 198]]);
    dashRef.current.carry = false;
    mailFlashRef.current = 60;
    log(`  ส่งคำตอบกลับแล้ว ✓ (${intent})`, "g");
    await sleep(500);
    await walkPath([[160, 150]]);
    setAgent(4, "done");
  }, [log, setAgent, setCap, walkPath]);

  // ---- play one trace's events in sequence ----
  const resetRoom = useCallback(() => {
    AGENTS.forEach((_, i) => setAgent(i, "idle"));
    const d = dashRef.current; d.x = 160; d.y = 150; d.tx = null; d.ty = null; d.carry = false; d.face = "down";
  }, [setAgent]);

  const applyEvent = useCallback(async (e: MonEvent) => {
    // new trace → fresh room
    if (e.traceId !== curTraceRef.current) {
      curTraceRef.current = e.traceId;
      resetRoom();
      // Placeholder: keep the internal "last LLM used" state,
      // but hide the visible "LLM —" until we actually parse a label.
      lastLlmRef.current = "—";
      setLlmLabel("");
      setLlmHot(false);
      log(`> คำขอใหม่จาก ${e.user} (${e.channel})`, "b");
      setHud("WORKING", "var(--amber)");
    }

    const llmFromLabel = parseLlm(e.label);
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
      for (let i = 0; i < 4; i++) if (statusRef.current[i] === "work") setAgent(i, "done");
      await courierReply(intent);
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
      return;
    }

    // receive / parse / fetch / compose
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
  }, [courierReply, log, resetRoom, setAgent, setCap, setHud, setLlmHud]);

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

        <div className="panel">
          <div className="ph">
            <span>THE OFFICE</span>
            <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className={`badge llm${llmHot ? " hot" : ""}`} style={{ fontSize: 14, padding: "2px 6px" }} title={llmChain || "AI API provider"}>
                LLM <b ref={(el) => { llmHudRef.current = el; }}>{llmLabel}</b>
              </span>
              <span className="live">● LIVE</span>
            </span>
          </div>
          <div className="room-stage" ref={stageRef}>
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
          </div>
          <div className="caption" ref={capRef}>รอคำขอเข้ามา… (คุยกับผู้ช่วยผ่าน LINE แล้วดูที่นี่)</div>
        </div>

        <div className="cols">
          <div className="panel"><div className="ph"><span>CONSOLE</span></div><div id="log" ref={logRef} /></div>
          <div className="panel">
            <div className="ph"><span>STAGES</span></div>
            <div id="legend">
              {AGENTS.map((a) => (
                <div className="row" key={a.id}>
                  <span className="sw" style={{ background: a.shirt }} />
                  <span><span className="rl">{a.role}</span> <span className="rc">— {a.cap}</span></span>
                </div>
              ))}
              {llmChain ? (
                <div className="row" style={{ marginTop: 10, alignItems: "flex-start" }}>
                  <span className="sw" style={{ background: "#f0b429" }} />
                  <span>
                    <span className="rl">LLM KEYS</span>{" "}
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
