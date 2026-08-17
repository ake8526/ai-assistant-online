import crypto from "crypto";
import { allSettings, getSetting, setSetting } from "@/lib/store";

// Meeting summaries as a page instead of a wall of chat.
//
// Why: LINE bills per message bubble, and a long summary is split into up to
// five — times every attendee. One short message with a link costs one bubble
// per person no matter how long the meeting was, and reads better on a phone
// than five screens of scrollback.
//
// The page is protected the way file links already are: a signed, expiring
// token. No new table — the payload lives in `settings` like every other cache
// in this app, because the one migration this project relied on was never run.

const APP_BASE = (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "");
const OPS = "_ops";
const PREFIX = "mtsum_";
const PILOT_KEY = "summary_link_pilot";
/** Long enough to read it after a holiday, short enough that a forwarded link
 *  does not stay open forever. */
const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  return process.env.FILE_LINK_SECRET || process.env.LINE_CHANNEL_SECRET || "dev-summary-link";
}

export type StoredSummary = {
  subject: string;
  /** Human-readable meeting time, already in Bangkok wall clock. */
  when: string;
  /** The full formatted summary text (same text LINE used to receive). */
  text: string;
  actionItems: string[];
  createdAt: number;
};

const rowKey = (id: string) => `${PREFIX}${id}`;

/** Stable per meeting, so every attendee opens the same page. */
export function summaryIdFor(meetingKey: string): string {
  return crypto.createHash("sha1").update(meetingKey).digest("hex").slice(0, 16);
}

export async function saveSummaryPage(id: string, payload: StoredSummary): Promise<void> {
  await setSetting(OPS, rowKey(id), JSON.stringify(payload));
}

export async function loadSummaryPage(id: string): Promise<StoredSummary | null> {
  const raw = await getSetting(OPS, rowKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSummary;
  } catch {
    return null;
  }
}

function sign(id: string, exp: number): string {
  return crypto.createHmac("sha256", secret()).update(`${id}|${exp}`).digest("base64url");
}

export function buildSummaryUrl(id: string): string {
  const exp = Date.now() + LINK_TTL_MS;
  return `${APP_BASE}/s/${id}.${exp}.${sign(id, exp)}`;
}

/** Returns the summary id when the token is intact and unexpired. */
export function readSummaryToken(token: string): string | null {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [id, expRaw, sig] = parts;
  const exp = parseInt(expRaw, 10);
  if (!id || !Number.isFinite(exp) || Date.now() > exp) return null;
  try {
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(sign(id, exp), "base64url");
    if (a.length !== b.length) return null;
    return crypto.timingSafeEqual(a, b) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Who receives the link form instead of the full text. Kept as a list so this
 * can be tried on one person before everybody's summaries change shape.
 */
export async function linkPilot(): Promise<string[]> {
  const raw = await getSetting(OPS, PILOT_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.map((x) => String(x).toLowerCase()) : [];
  } catch {
    return [];
  }
}

export async function isLinkPilot(upn: string): Promise<boolean> {
  return (await linkPilot()).includes((upn || "").toLowerCase());
}

export async function setLinkPilot(upns: string[]): Promise<string[]> {
  const clean = [...new Set(upns.map((u) => u.trim().toLowerCase()).filter((u) => u.includes("@")))];
  await setSetting(OPS, PILOT_KEY, JSON.stringify(clean));
  return clean;
}

/** The short message that replaces the full summary in chat. */
export function summaryTeaser(subject: string, when: string, text: string, url: string): string {
  const bullets = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[•\-*]/.test(l))
    .slice(0, 2)
    .map((l) => `• ${l.replace(/^[•\-*]\s*/, "")}`);
  return [
    `📝 สรุปประชุม · ${subject}`,
    when ? `🕐 ${when}` : "",
    "",
    ...(bullets.length ? bullets : ["สรุปพร้อมแล้ว"]),
    "",
    `อ่านฉบับเต็ม 👉 ${url}`,
  ]
    .filter((l) => l !== undefined)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * The `/test` preview. Uses the person's most recent real summary when there is
 * one — a preview built from fabricated text would not show whether their own
 * meetings render properly. Replies are free, so this can be run as often as
 * wanted, even with the monthly push quota at zero.
 */
export async function previewSummaryLinkMessage(upn: string): Promise<string> {
  const inPilot = await isLinkPilot(upn);

  // 1) A summary this person already received — instant, and unmistakably real.
  let real: { id: string; subject: string; when: string; text: string; actionItems: string[] } | null = null;
  const rows = await allSettings(upn);
  const delivered = Object.entries(rows)
    .filter(([k, v]) => k.startsWith("sm_dlv_") && v)
    .map(([k, v]) => ({ id: k.slice("sm_dlv_".length), ts: parseInt(v, 10) || 0 }))
    .sort((a, b) => b.ts - a.ts);
  for (const d of delivered) {
    const page = await loadSummaryPage(d.id);
    if (page) {
      real = { id: d.id, ...page };
      break;
    }
  }

  // 2) Nothing delivered yet (the usual case while the push quota is spent) —
  //    summarise their most recent real meeting instead. Costs one LLM call and
  //    no LINE message, and does not stop the scheduled run delivering it later.
  if (!real) {
    const { buildPreviewSummary } = await import("@/lib/meetings");
    try {
      real = await buildPreviewSummary(upn);
    } catch {
      real = null;
    }
  }

  if (real) {
    const url = buildSummaryUrl(real.id);
    // Shown exactly as it will arrive — a preview that explains itself is no
    // longer showing you what you will get.
    void inPilot;
    return summaryTeaser(real.subject, real.when, real.text, url);
  }

  // 3) No finished meeting with a transcript in the last three days — say so
  //    plainly rather than dressing a demo up as the real thing.
  return [
    "ยังสร้างตัวอย่างจากข้อมูลจริงไม่ได้ครับ",
    "",
    "ไม่พบประชุมออนไลน์ที่จบแล้วและมี transcript ใน 3 วันล่าสุด",
    "(สรุปอัตโนมัติทำได้เฉพาะประชุม Teams ที่เปิดบันทึก transcript ไว้)",
    "",
    "พอมีประชุมที่เข้าเงื่อนไข พิมพ์ /test อีกครั้งจะเห็นของจริงทันที",
  ].join("\n");
}
