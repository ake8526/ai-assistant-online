import crypto from "crypto";
import { getSetting, setSetting } from "@/lib/store";
import type { Story } from "@/lib/digest";

// The morning news as a page, and the morning message that links to it.
//
// Two things happen here, for the same reason. The agenda stays in chat in
// full — people reply to it, ask "เตรียมนัด 2", and that conversation has to
// keep working. The news does not get replied to; it gets read. So the news
// moves to a page and the morning becomes ONE message instead of two, which is
// where the real saving is: 300 free pushes a month, four people, two messages
// a day each, and the month is gone before anything else is sent.

const APP_BASE = (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "");
const OPS = "_ops";
const PREFIX = "newspage_";
const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  return process.env.FILE_LINK_SECRET || process.env.LINE_CHANNEL_SECRET || "dev-summary-link";
}

export type NewsPageStory = {
  topic: string;
  headline: string;
  /** ความเรียงเล่าเรื่อง — รูปแบบหลัก points เป็นทางถอยของข้อมูลเก่า */
  story?: string;
  points: string[];
  link: string;
  /** Written from the headline and blurb because the source blocked the fetch. */
  thin?: boolean;
};

export type StoredNews = {
  /** Bangkok date the digest was built for, e.g. "17 ส.ค. 2569". */
  dateLabel: string;
  stories: NewsPageStory[];
  note?: string;
  createdAt: number;
};

const rowKey = (id: string) => `${PREFIX}${id}`;

/** One page per person per day — re-running the morning overwrites it. */
export function newsIdFor(upn: string, dateIso: string): string {
  return crypto.createHash("sha1").update(`${upn}|${dateIso}`).digest("hex").slice(0, 16);
}

export async function saveNewsPage(id: string, payload: StoredNews): Promise<void> {
  await setSetting(OPS, rowKey(id), JSON.stringify(payload));
}

export async function loadNewsPage(id: string): Promise<StoredNews | null> {
  const raw = await getSetting(OPS, rowKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredNews;
  } catch {
    return null;
  }
}

function sign(id: string, exp: number): string {
  return crypto.createHmac("sha256", secret()).update(`n|${id}|${exp}`).digest("base64url");
}

export function buildNewsUrl(id: string): string {
  const exp = Date.now() + LINK_TTL_MS;
  return `${APP_BASE}/n/${id}.${exp}.${sign(id, exp)}`;
}

export function readNewsToken(token: string): string | null {
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

/** Digest stories → the shape the page renders, keeping the source link. */
export function toPageStories(stories: Story[]): NewsPageStory[] {
  return stories.map((s) => {
    const bullets = (s.bullets?.length
      ? s.bullets
      : [s.whatHappened, s.cause, s.progress, s.conclusion]
    )
      .map((b) => (b || "").trim())
      .filter(Boolean);
    const story = (s.story || "").trim();
    return {
      topic: (s.source || "").replace(/^หัวข้อ\s*·\s*/u, "").trim() || s.source || "",
      headline: bullets[0] || s.title || "",
      story,
      // มีความเรียงแล้วไม่ต้องโชว์หัวข้อย่อยซ้ำอีก — เก็บไว้เฉพาะตอนที่เล่าไม่มา
      points: story ? [] : bullets.slice(1, 6),
      link: s.rawLink || s.shortLink || "",
      thin: !!s.thin,
    };
  });
}

/** The news footer appended to the agenda — one line, one link. */
export function newsFooter(count: number, url: string): string {
  if (!count) return "📰 ข่าวเช้า — วันนี้ยังไม่มีข่าวใหม่จากแหล่งที่ติดตาม";
  return [`📰 ข่าวเช้า ${count} เรื่อง`, `อ่านที่นี่ 👉 ${url}`].join("\n");
}

export type MorningHalf = { key: "am" | "pm" | "all"; label: string; count: number };

/**
 * The morning message as one bubble.
 *
 * It used to paste the whole agenda in. That made the single most-read message
 * of the day a wall that LINE folds behind "See more" — and the news link,
 * being last, sat inside the folded part where nobody found it.
 *
 * So it now says only how many meetings there are and offers the half-day the
 * reader asks for. Opening a half is a reply, and replies are free, while every
 * proactive line costs one of the 300 pushes the month allows.
 */
export async function buildMorningPreview(
  upn: string,
  opts: { fastNews?: boolean; withNews?: boolean } = {}
): Promise<{
  message: string;
  /** ตารางแบบเต็มสำหรับกล่องในแอป ซึ่งมีที่ให้อ่านไม่เหมือนในแชท */
  agendaText: string;
  /** ข่าวดิบที่ส่งไปจริง — ผู้เรียกต้องเอาไปทำเครื่องหมายว่าส่งแล้ว
   *  ไม่งั้นพรุ่งนี้ buildDigest จะหยิบข่าวชุดเดิมมาส่งซ้ำ */
  delivered: Story[];
  newsUrl: string;
  newsCount: number;
  agendaChars: number;
  halves: MorningHalf[];
  choices: { index: number; label: string }[];
}> {
  const { buildMorningAgenda, splitDayHalves, loadAgendaSnapshot } = await import("@/lib/brief");
  const { withDelegatedGraph } = await import("@/lib/msGraphOAuth");
  const { loadNewsPrewarm, loadBriefPrewarm } = await import("@/lib/morningCache");
  const { buildDigest } = await import("@/lib/digest");
  const { nowWall } = await import("@/lib/time");

  /* ใช้ตารางที่ /api/morning/prewarm เตรียมไว้ตั้งแต่ 06:5x ถ้ามี — นาทีที่ต้องส่ง
     ไม่ควรเสียเวลารอ Graph ตอบ ยิ่งมีผู้ใช้หลายคนยิ่งบวกกันจนเลยเวลาที่ตั้งไว้

     กับดักที่ต้องระวัง: loadBriefPrewarm คืน events เป็น [] โดยตั้งใจ (คอมเมนต์
     ในไฟล์นั้นบอกว่าตัวเต็มอยู่ใน agenda snapshot) ถ้าเอาไปนับครึ่งวันตรง ๆ จะได้
     "ไม่มีนัด" ทุกเช้าทั้งที่มีนัด จึงต้องหยิบ events จาก snapshot มาประกบเสมอ
     และถ้า snapshot ว่างก็ถอยไปดึงสด ดีกว่าบอกผิดว่าไม่มีอะไร */
  const warm = await loadBriefPrewarm(upn);
  const warmEvents = warm ? await loadAgendaSnapshot(upn) : [];
  const agenda =
    warm && warmEvents.length
      ? { ...warm.agenda, events: warmEvents }
      : (await withDelegatedGraph(upn, () => buildMorningAgenda(upn))).result;

  // The page has room and is not on the morning's clock, so it is built with the
  // thorough reader: 15s to fetch each article instead of 8, and 28s for the
  // writer instead of 14. The fast path was producing bullets that only restated
  // the headline — "เหมือนเอาแค่หัวข้อมา", which is exactly what a summary is not.
  /* ปิดข่าวไว้ก็ไม่ต้องไปดึงข่าวเลย — ไม่ใช่ดึงมาแล้วค่อยไม่แสดง
     (มีคนตั้งไว้แบบนั้นจริง คนหนึ่งเอาแต่ตาราง ไม่เอาข่าว) */
  const wantNews = opts.withNews !== false;
  const cached = wantNews ? await loadNewsPrewarm(upn) : null;
  // A LINE reply token is only good for about a minute, and the thorough read
  // takes ~25s. Cap it: past the limit, say so rather than letting the whole
  // reply fail and leave the user with nothing.
  const NEWS_BUDGET_MS = 35_000;
  let timedOut = false;
  let digest = cached;
  if (!wantNews) {
    digest = { stories: [], skipped: [], note: "" };
  } else if (!digest) {
    const built = await Promise.race([
      buildDigest(upn, { fast: !!opts.fastNews }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), NEWS_BUDGET_MS)),
    ]);
    if (built) {
      digest = built;
    } else {
      timedOut = true;
      digest = { stories: [], skipped: [], note: "สรุปข่าวไม่ทันในรอบนี้ ลองใหม่อีกครั้งครับ" };
    }
  }

  const stories = toPageStories(digest.stories || []);

  const w = nowWall();
  const months = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const dateLabel = `${w.getUTCDate()} ${months[w.getUTCMonth()]} ${w.getUTCFullYear() + 543}`;
  const dateIso = `${w.getUTCFullYear()}-${w.getUTCMonth() + 1}-${w.getUTCDate()}`;

  const id = newsIdFor(upn, dateIso);
  await saveNewsPage(id, { dateLabel, stories, note: digest.note, createdAt: Date.now() });
  const newsUrl = buildNewsUrl(id);

  const { allDay, am, pm, cancelled } = splitDayHalves(agenda.events);
  /* นับเฉพาะนัดที่ยังมีอยู่จริง และนับทุกใบครั้งเดียว — นัดทั้งวันเป็นกลุ่มของ
     ตัวเอง ไม่ใส่ทั้งเช้าและบ่าย ไม่งั้นผลรวมของสามกลุ่มจะเกินจำนวนจริง */
  const total = allDay.length + am.length + pm.length;
  const halves: MorningHalf[] = [];
  if (allDay.length) halves.push({ key: "all", label: "ทั้งวัน", count: allDay.length });
  if (am.length) halves.push({ key: "am", label: "ช่วงเช้า", count: am.length });
  if (pm.length) halves.push({ key: "pm", label: "ช่วงบ่าย", count: pm.length });

  /* บอกจำนวนก่อน แล้วค่อยให้เลือกดู — และเมื่อมีกลุ่มเดียวก็บอกไปตรง ๆ ว่ากลุ่มไหน
     ถามว่า "เช้าหรือบ่าย" ทั้งที่มีแต่บ่าย เป็นคำถามที่คนตอบแล้วรู้สึกว่าไม่ได้ฟัง */
  const cancelNote = cancelled.length ? `\n(อีก ${cancelled.length} รายการถูกยกเลิกแล้ว ไม่นับให้)` : "";
  let agendaLine: string;
  if (!total) {
    agendaLine = `📅 วันนี้ไม่มีนัดในปฏิทินครับ${cancelNote}`;
  } else if (halves.length === 1) {
    const only = halves[0]!;
    const what = only.key === "all" ? "นัดทั้งวัน" : `นัด${only.label}`;
    agendaLine = [`📅 วันนี้มี${what} ${only.count} เรื่อง${cancelNote}`, "ดูรายการเลยไหมครับ?"].join("\n");
  } else {
    const parts = halves.map((h) => `${h.label} ${h.count}`).join(" · ");
    agendaLine = [
      `📅 วันนี้มีนัด ${total} เรื่อง — ${parts}${cancelNote}`,
      "อยากดูช่วงไหนก่อนครับ?",
    ].join("\n");
  }

  const message = [
    "🌅 สรุปเช้านี้",
    "",
    agendaLine,
    ...(wantNews ? ["", "─────────────", newsFooter(stories.length, newsUrl)] : []),
  ].join("\n");

  return {
    message,
    agendaText: agenda.text,
    delivered: digest.stories || [],
    newsUrl,
    newsCount: stories.length,
    agendaChars: agenda.text.length,
    halves,
    choices: agenda.choices.map((c) => ({ index: c.index, label: c.label || "" })),
  };
}
