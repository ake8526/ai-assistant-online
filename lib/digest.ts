// Shared news-digest builder — used by the /api/digest route AND the chat/LINE
// command handler ("มีข่าวอะไรบ้าง"). Pulls the user's granted feeds + YouTube
// subscriptions, picks highlights, and writes 4-point Thai summaries.
import { createHash } from "crypto";
import { admin } from "@/lib/supabaseServer";
import { fetchFeed, fetchArticle, type FeedEntry } from "@/lib/rss";
import { recentPosts as facebookPosts } from "@/lib/facebook";
import { chat } from "@/lib/llm";
import { getNewsCount, isNewsCountAll, NEWS_COUNT_ALL_CAP } from "@/lib/notify";
import { nowWall, TZ_OFFSET_MIN } from "@/lib/time";
import { getSetting } from "@/lib/store";
import * as youtube from "@/lib/youtube";

export interface Story {
  id: string;
  title: string;
  source: string;
  kind: "rss" | "youtube" | "facebook" | "newsdata";
  whatHappened: string;
  cause: string;
  progress: string;
  conclusion: string;
  shortLink: string;
  rawLink: string;
  publishedAt: string;
}

export interface DigestResult {
  stories: Story[];
  skipped: string[];
  note?: string;
}

const CAP_BY_KIND: Record<string, string> = { rss: "src_rss", youtube: "src_youtube", facebook: "src_facebook" };

function bkkDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** True if `published` falls on today's Bangkok calendar date. */
function isPublishedTodayBkk(published: string): boolean {
  if (!published?.trim()) return false;
  const today = bkkDateString(nowWall());
  const raw = published.trim();
  // Fast path: leading YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) && raw.slice(0, 10) === today) return true;
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return raw.slice(0, 10) === today;
  // Convert instant → Bangkok wall components in UTC fields
  const bkk = new Date(parsed.getTime() + TZ_OFFSET_MIN * 60_000);
  return bkkDateString(bkk) === today;
}

/** Render stories as a plain-text digest (for LINE push and the chat reply). */
export function formatStoriesText(stories: Story[]): string {
  const lines = ["📰 สรุปข่าวที่คุณติดตามวันนี้", ""];
  stories.forEach((s, i) => {
    lines.push(`${i + 1}) ${s.title} — ${s.source}`);
    if (s.whatHappened) lines.push(`   • เกิดอะไรขึ้น: ${s.whatHappened}`);
    if (s.cause) lines.push(`   • สาเหตุ: ${s.cause}`);
    if (s.progress) lines.push(`   • เป็นยังไงต่อ: ${s.progress}`);
    if (s.conclusion) lines.push(`   • สรุป: ${s.conclusion}`);
    if (s.rawLink) lines.push(`   🔗 ${s.rawLink}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

export async function buildDigest(upn: string): Promise<DigestResult> {
  // 1) consents + feeds
  const { data: consentRows } = await admin.from("consents").select("capability, granted").eq("owner_upn", upn);
  const granted = new Set((consentRows || []).filter((r) => r.granted).map((r) => r.capability));
  const { data: feedsData } = await admin
    .from("feeds")
    .select("*")
    .eq("owner_upn", upn)
    .order("created_at", { ascending: true });
  const feeds = feedsData || [];
  const newestLabel = feeds.length ? (feeds[feeds.length - 1].label || "") : "";

  // 2) gather items
  const items: (FeedEntry & { kind: string; feedLabel: string })[] = [];
  const skipped: string[] = [];

  const newsCount = await getNewsCount(upn);

  // 2a) manually-added feeds (RSS + Facebook pages)
  for (const f of feeds) {
    if (!granted.has(CAP_BY_KIND[f.kind])) {
      skipped.push(`${f.label || f.kind} (ไม่ได้อนุญาตแหล่งชนิด ${f.kind})`);
      continue;
    }
    if (f.kind === "rss") {
      const entries = await fetchFeed(f.ref);
      entries.forEach((e) => items.push({ ...e, kind: f.kind, feedLabel: f.label || e.source }));
    } else if (f.kind === "facebook") {
      try {
        const entries = await facebookPosts(f.ref, 8);
        if (!entries.length) skipped.push(`${f.label || "Facebook"} (ดึงโพสต์ไม่ได้ — ตรวจ App / สิทธิ์เพจ)`);
        entries.forEach((e) => items.push({ ...e, kind: f.kind, feedLabel: f.label || e.source }));
      } catch (e) {
        skipped.push(`${f.label || "Facebook"} (${String(e).slice(0, 60)})`);
      }
    } else if (f.kind !== "youtube") {
      skipped.push(`${f.label || f.kind} (${f.kind} ยังไม่รองรับบน Vercel)`);
    }
  }

  // 2b) YouTube — auto-pull the user's subscriptions (no manual entry) when connected
  if (granted.has("src_youtube") && youtube.isConfigured()) {
    const { data: tok } = await admin.from("oauth_tokens").select("refresh_token").eq("owner_upn", upn).eq("provider", "google").single();
    if (tok?.refresh_token) {
      try {
        const vids = await youtube.recentUploads(tok.refresh_token);
        vids.forEach((v) => items.push({ ...v, kind: "youtube", feedLabel: v.source }));
      } catch (e) {
        skipped.push(`YouTube (ดึงไม่สำเร็จ: ${String(e).slice(0, 60)})`);
      }
    } else {
      skipped.push("YouTube (ยังไม่ได้เชื่อมบัญชี Google)");
    }
  }

  // 2c) NewsData.io — always on when NEWSDATA_API_KEY is set (no user toggle)
  {
    const { isNewsDataConfigured, fetchNewsDataNews } = await import("@/lib/newsdata");
    if (isNewsDataConfigured()) {
      try {
        const entries = await fetchNewsDataNews({ limit: 10 });
        if (!entries.length) skipped.push("NewsData (ไม่มีข่าวในช่วงนี้)");
        entries.forEach((e) => items.push({ ...e, kind: "newsdata", feedLabel: e.source }));
      } catch (e) {
        skipped.push(`NewsData (${String(e).slice(0, 80)})`);
      }
    }
  }

  if (items.length === 0) {
    return { stories: [], skipped, note: "ยังไม่มีเนื้อหา — เชื่อม YouTube หรือเพิ่มแหล่งข่าว" };
  }

  items.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  const wantAll = isNewsCountAll(newsCount);

  // "ทั้งหมด" = every item published/updated today (Bangkok), not older backlog
  let pool: typeof items;
  let highlightN: number;
  if (wantAll) {
    const todayItems = items.filter((it) => isPublishedTodayBkk(it.published || ""));
    if (todayItems.length === 0) {
      return {
        stories: [],
        skipped,
        note: "วันนี้ยังไม่มีข่าว/คลิปใหม่จากแหล่งที่คุณติดตาม",
      };
    }
    pool = todayItems.slice(0, NEWS_COUNT_ALL_CAP);
    highlightN = pool.length; // take all of today's items (within cap)
  } else {
    pool = items.slice(0, 25);
    highlightN = Math.max(1, Math.min(newsCount, 10));
  }

  // 3) stage 1 — pick N highlights (or all of today's pool); prefer newest-followed feed a bit
  const bonusNew = wantAll ? 0 : Math.min(2, Math.max(0, highlightN - 1));
  let picks: number[] = [];
  if (wantAll) {
    picks = pool.map((_, i) => i);
  } else {
    const listing = pool
      .map((it, i) => `${i}. [${it.feedLabel}]${it.feedLabel === newestLabel ? " [ใหม่]" : ""} ${it.title}`)
      .join("\n");
    try {
      const raw = await chat(
        `เลือกข่าวเด่นที่สุดจากรายการ (มี index) ตอบ JSON เท่านั้น {"highlights":[index ${highlightN} อัน],"new":[index จากแหล่ง [ใหม่] ไม่เกิน ${bonusNew}]}`,
        listing,
        { json: true, temperature: 0 }
      );
      const d = JSON.parse(raw);
      picks = [...(d.highlights || []), ...(d.new || [])].filter(
        (n: unknown) => typeof n === "number" && n >= 0 && n < pool.length
      );
    } catch {
      picks = [];
    }
    if (picks.length === 0) picks = pool.slice(0, highlightN).map((_, i) => i);
    picks = Array.from(new Set(picks)).slice(0, highlightN);
  }

  // 4) fetch article text + stage 2 write 4-point summaries
  const chosen = picks.map((i) => pool[i]);
  const withText = await Promise.all(
    chosen.map(async (it) => ({ ...it, full: (await fetchArticle(it.link)) || it.summary }))
  );
  const writerInput = withText
    .map((it, i) => `#${i}\nหัวข้อ: ${it.title}\nแหล่ง: ${it.feedLabel}\nเนื้อหา: ${it.full.slice(0, 4000)}`)
    .join("\n\n");
  let summaries: Record<string, { whatHappened?: string; cause?: string; progress?: string; conclusion?: string }> = {};
  try {
    const raw = await chat(
      'สรุปข่าวแต่ละชิ้นจากเนื้อหาที่ให้ (index #N) ตอบ JSON เท่านั้น: ' +
        '{"0":{"whatHappened":"เกิดอะไรขึ้น 1-2 ประโยค","cause":"เรื่องเกิดจากอะไร 1-2 ประโยค","progress":"เป็นยังไงต่อ 1-2 ประโยค","conclusion":"จบยังไง/แนวโน้ม 1-2 ประโยค"}, ...} ' +
        "สรุปจากเนื้อหาจริงเท่านั้น ห้ามแต่งเพิ่ม",
      writerInput,
      { json: true, temperature: 0.3 }
    );
    summaries = JSON.parse(raw);
  } catch {
    summaries = {};
  }

  // 5) build stories
  const stories: Story[] = [];
  for (let i = 0; i < withText.length; i++) {
    const it = withText[i];
    const s = summaries[String(i)] || {};
    stories.push({
      id: createHash("sha1").update(it.link).digest("hex").slice(0, 8),
      title: it.title,
      source: it.feedLabel,
      kind: it.kind as Story["kind"],
      whatHappened: s.whatHappened || it.summary.slice(0, 200),
      cause: s.cause || "",
      progress: s.progress || "",
      conclusion: s.conclusion || "",
      shortLink: it.link,
      rawLink: it.link,
      publishedAt: it.published || "",
    });
  }

  return { stories, skipped };
}
