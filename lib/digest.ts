// Shared news-digest builder — used by the /api/digest route AND the chat/LINE
// command handler ("มีข่าวอะไรบ้าง"). Pulls the user's granted feeds + YouTube
// subscriptions, picks highlights, and writes natural Thai bullet summaries.
import { createHash } from "crypto";
import { admin } from "@/lib/supabaseServer";
import { fetchFeed, fetchArticle, type FeedEntry } from "@/lib/rss";
import { recentPosts as facebookPosts } from "@/lib/facebook";
import { summaryChat } from "@/lib/llm";
import { getNewsCount, isNewsCountAll, NEWS_COUNT_ALL_CAP } from "@/lib/notify";
import { nowWall, TZ_OFFSET_MIN } from "@/lib/time";
import { loadSeenNewsKeys, newsStoryKey } from "@/lib/store";
import { trace } from "@/lib/trace";
import * as youtube from "@/lib/youtube";

export interface Story {
  id: string;
  title: string;
  source: string;
  kind: "rss" | "youtube" | "facebook";
  /** Natural bullet points (หัวข้อย่อย) — preferred display form. */
  bullets: string[];
  /** @deprecated kept for older clients; prefer bullets */
  whatHappened: string;
  cause: string;
  progress: string;
  conclusion: string;
  shortLink: string;
  rawLink: string;
  publishedAt: string;
  /** The source blocked the fetch, so this was written from the headline and
   *  RSS blurb alone. Said out loud rather than passed off as a full summary. */
  thin?: boolean;
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
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) && raw.slice(0, 10) === today) return true;
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return raw.slice(0, 10) === today;
  const bkk = new Date(parsed.getTime() + TZ_OFFSET_MIN * 60_000);
  return bkkDateString(bkk) === today;
}

function storyBullets(s: Story): string[] {
  if (s.bullets?.length) return s.bullets.filter((b) => b.trim());
  return [s.whatHappened, s.cause, s.progress, s.conclusion].filter((b) => (b || "").trim());
}

/** Drop meta lines that admit there is no content (common LLM failure mode). */
function isHollowBullet(b: string): boolean {
  const t = b.trim();
  if (t.length < 8) return true;
  return /ไม่มี(รายละเอียด|ข้อมูล|เนื้อหา)|ไม่ระบุ|ไม่ได้ระบุ|ไม่ได้อธิบาย|ไม่ทราบรายละเอียด|เนื้อหาไม่พอ|เนื้อหาสั้น|No further|ไม่พบข้อมูลเพิ่ม|ONLY AVAILABLE IN PAID PLANS/i.test(
    t
  );
}

/** True if text looks cut mid-sentence (bad for LINE). */
function isTruncatedGarbage(b: string): boolean {
  const t = b.trim();
  if (!t) return true;
  if (/\[\.\.\.\]/.test(t)) return true;
  if (/\.\.\.\s*$|…\s*$/.test(t) && t.length > 40) return true;
  return false;
}

/** Cut at sentence/word boundary — never mid-word with [...]. */
function clipComplete(text: string, max = 320): string {
  let t = (text || "")
    .replace(/\s+/g, " ")
    .replace(/\[\.\.\.\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const window = t.slice(0, max);
  const marks = ["។", "．", "。", ".", "!", "?", " "].map((m) => window.lastIndexOf(m));
  let cut = Math.max(...marks);
  if (cut < max * 0.4) cut = max;
  else if (window[cut] !== " ") cut = cut + 1;
  return window.slice(0, cut).trim();
}

function cleanBullet(b: string): string {
  return (b || "")
    .replace(/\s+/g, " ")
    .replace(/\[\.\.\.\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isPaywalledSnippet(s: string): boolean {
  return /ONLY AVAILABLE IN PAID PLANS/i.test(s || "");
}

/** Merge RSS/NewsData snippet + scraped article; keep the richest useful text. */
function bestArticleBody(title: string, summary: string, scraped: string): string {
  const t = (title || "").trim();
  const sum = (summary || "").trim();
  const art = (scraped || "").trim();
  const artUseful =
    art.length >= 120 &&
    !/^(cookie|accept|subscribe|sign in|เข้าสู่ระบบ|javascript)/i.test(art.slice(0, 80));

  // Prefer the longer high-quality body; don't lock onto a short teaser.
  if (artUseful && art.length >= sum.length) {
    const merged = sum.length >= 40 && !art.includes(sum.slice(0, Math.min(40, sum.length)))
      ? `${sum}\n\n${art}`
      : art;
    return merged.slice(0, 7000);
  }
  if (sum.length >= 40 && artUseful) {
    const extra = art.includes(sum.slice(0, 40)) ? art : `${sum}\n\n${art}`;
    return extra.slice(0, 7000);
  }
  if (sum.length >= 40) return sum.slice(0, 7000);
  if (artUseful) return art.slice(0, 7000);
  return (sum || art || t).slice(0, 7000);
}

/** Render stories as a natural briefing (for LINE push and chat). */
export function formatStoriesText(stories: Story[], note?: string): string {
  const n = stories.length;
  const lines = [`📰 ข่าววันนี้ · ${n} เรื่องเด่น`, ""];
  if (note) {
    lines.push(`ℹ️ ${note}`, "");
  }
  stories.forEach((s, i) => {
    const bullets = storyBullets(s)
      .map((b) => cleanBullet(b))
      .filter((b) => b && !isHollowBullet(b) && !isTruncatedGarbage(b));
    const headline = bullets[0] || cleanBullet(s.title);
    const points = bullets.slice(1);
    const topic = (s.source || "").replace(/^หัวข้อ\s*·\s*/u, "").trim() || s.source;
    lines.push(`${i + 1}) ${topic}`);
    lines.push(`   ${headline}`);
    for (const p of points.slice(0, 5)) lines.push(`   • ${p}`);
    if (s.rawLink) lines.push(`   🔗 ${s.rawLink}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

export type DigestOptions = {
  /** Morning cron: finish under ~3 min — skip captions/repairs, shorter scrapes. */
  fast?: boolean;
};

export async function buildDigest(upn: string, opts: DigestOptions = {}): Promise<DigestResult> {
  const fast = !!opts.fast;
  trace("fetch", fast ? "📰 เริ่มรวบรวมข่าว (เร็ว)" : "📰 เริ่มรวบรวมข่าว", "start");
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
  type DigestItem = FeedEntry & {
    kind: string;
    feedLabel: string;
    fromTopic?: boolean;
    videoId?: string;
  };
  const items: DigestItem[] = [];
  const skipped: string[] = [];

  const newsCount = await getNewsCount(upn);

  // 2a) manually-added feeds (RSS + Facebook pages) — fetch in parallel
  const feedResults = await Promise.all(
    feeds.map(async (f) => {
      if (!granted.has(CAP_BY_KIND[f.kind])) {
        return { skip: `${f.label || f.kind} (ไม่ได้อนุญาตแหล่งชนิด ${f.kind})`, entries: [] as DigestItem[] };
      }
      if (f.kind === "rss") {
        if (/facebook\.com/i.test(f.ref || "")) {
          return {
            skip: `${f.label || "RSS"} (ลิงก์เป็น Facebook — เพิ่มเป็นแหล่ง Facebook หรือเปิดสิทธิ์ Facebook)`,
            entries: [] as DigestItem[],
          };
        }
        const rssLabel = (f.label || f.ref || "RSS").slice(0, 60);
        trace("fetch", `📰 RSS · ${rssLabel}`, "start");
        const entries = await fetchFeed(f.ref);
        trace("fetch", `📰 RSS · ${rssLabel} · ${entries.length} รายการ`);
        return {
          skip: null as string | null,
          entries: entries.map((e) => ({ ...e, kind: f.kind, feedLabel: f.label || e.source })),
        };
      }
      if (f.kind === "facebook") {
        if (fast) {
          return { skip: `${f.label || "Facebook"} (ข้ามในรอบเช้า — ใช้แหล่งอื่นก่อน)`, entries: [] as DigestItem[] };
        }
        const fbLabel = (f.label || "Facebook").slice(0, 60);
        trace("fetch", `📰 Facebook · ${fbLabel}`, "start");
        try {
          const entries = await Promise.race([
            facebookPosts(f.ref, 8),
            new Promise<FeedEntry[]>((resolve) => setTimeout(() => resolve([]), 12_000)),
          ]);
          trace("fetch", `📰 Facebook · ${fbLabel} · ${entries.length} โพสต์`);
          return {
            skip: entries.length ? null : `${f.label || "Facebook"} (ดึงโพสต์ไม่ได้ — ตรวจ App / สิทธิ์เพจ)`,
            entries: entries.map((e) => ({ ...e, kind: f.kind, feedLabel: f.label || e.source })),
          };
        } catch (e) {
          trace("fetch", `📰 Facebook · ${fbLabel} ✗`, "error");
          return { skip: `${f.label || "Facebook"} (${String(e).slice(0, 60)})`, entries: [] as DigestItem[] };
        }
      }
      if (f.kind !== "youtube") {
        return { skip: `${f.label || f.kind} (${f.kind} ยังไม่รองรับบน Vercel)`, entries: [] as DigestItem[] };
      }
      return { skip: null as string | null, entries: [] as DigestItem[] };
    })
  );
  for (const r of feedResults) {
    if (r.skip) skipped.push(r.skip);
    items.push(...r.entries);
  }

  // 2b) YouTube — pull uploads; keep extras as replacements when a clip has no captions
  const YT_HARD_CAP = fast ? 1 : 2;
  /** Extra clips to try when the primary has no usable captions/body (per slot). */
  const YT_REPLACE_MAX = 3;
  const YT_CANDIDATE_CAP = YT_HARD_CAP + YT_REPLACE_MAX * YT_HARD_CAP;
  if (granted.has("src_youtube") && youtube.isConfigured()) {
    const { data: tok } = await admin.from("oauth_tokens").select("refresh_token").eq("owner_upn", upn).eq("provider", "google").single();
    if (tok?.refresh_token) {
      try {
        trace("fetch", "📰 YouTube · subscriptions", "start");
        const vids = await Promise.race([
          youtube.recentUploads(tok.refresh_token),
          new Promise<Awaited<ReturnType<typeof youtube.recentUploads>>>((resolve) =>
            setTimeout(() => resolve([]), fast ? 12_000 : 25_000)
          ),
        ]);
        const sorted = [...vids].sort((a, b) => (b.published || "").localeCompare(a.published || ""));
        const candidates = sorted.slice(0, YT_CANDIDATE_CAP);
        trace(
          "fetch",
          `📰 YouTube · subscriptions · ใช้ได้ถึง ${YT_HARD_CAP} · สำรอง ${Math.max(0, candidates.length - YT_HARD_CAP)} คลิป`
        );
        for (const v of candidates) {
          items.push({
            title: v.title,
            link: v.link,
            published: v.published,
            summary: v.summary,
            source: v.source,
            kind: "youtube",
            feedLabel: v.source,
            videoId: v.videoId,
          });
        }
      } catch (e) {
        const msg = String(e);
        const ytHint = /refresh\s*400|invalid_grant|token/i.test(msg)
          ? "YouTube (เชื่อม Google ใหม่ที่หน้าตั้งค่า)"
          : `YouTube (ดึงไม่สำเร็จ — ลองเชื่อม Google ใหม่)`;
        skipped.push(ytHint);
      }
    } else {
      skipped.push("YouTube (ยังไม่ได้เชื่อมบัญชี Google)");
    }
  }

  // 2c) Topic interests — NewsData keyword search for user-selected topics
  {
    const { getNewsPrefs, topicQuery } = await import("@/lib/newsPrefs");
    const prefs = await getNewsPrefs(upn);
    if (prefs.interested && prefs.topics.length) {
      try {
        const { isNewsDataConfigured, fetchNewsByTopic } = await import("@/lib/newsdata");
        if (isNewsDataConfigured()) {
          const topicResults = await Promise.all(
            prefs.topics.slice(0, 6).map(async (topic) => {
              try {
                trace("fetch", `📰 NewsData · ${topic}`, "start");
                const entries = await fetchNewsByTopic(topicQuery(topic), 5);
                trace("fetch", `📰 NewsData · ${topic} · ${entries.length} รายการ`);
                if (!entries.length) return { skipped: `หัวข้อ “${topic}” (ไม่มีข่าวจาก NewsData)`, entries: [] as FeedEntry[] };
                return {
                  skipped: null as string | null,
                  entries: entries.map((e) => ({
                    ...e,
                    kind: "rss",
                    feedLabel: `หัวข้อ · ${topic}`,
                    fromTopic: true as const,
                    summary: e.summary || e.title,
                  })),
                };
              } catch (e) {
                return { skipped: `หัวข้อ “${topic}” (${String(e).slice(0, 60)})`, entries: [] as FeedEntry[] };
              }
            })
          );
          for (const r of topicResults) {
            if (r.skipped) skipped.push(r.skipped);
            for (const e of r.entries) items.push(e as DigestItem);
          }
        } else {
          skipped.push("หัวข้อข่าว (ยังไม่ได้ตั้ง NEWSDATA_API_KEY บนเซิร์ฟเวอร์)");
        }
      } catch (e) {
        skipped.push(`หัวข้อข่าว (${String(e).slice(0, 60)})`);
      }
    }
  }

  if (items.length === 0) {
    return { stories: [], skipped, note: "ยังไม่มีเนื้อหา — เชื่อม YouTube หรือเพิ่มแหล่งข่าว / เลือกหัวข้อ" };
  }

  // Skip stories already summarized — but if EVERYTHING was seen, still
  // re-pick highlights so “ข่าววันนี้” never comes back empty when sources have items.
  const seenKeys = await loadSeenNewsKeys(upn);
  let skippedSeen = 0;
  let repeatNote: string | undefined;
  if (seenKeys.size) {
    const fresh = items.filter((it) => {
      const k = newsStoryKey(it.link || "", it.title || "");
      return !k || !seenKeys.has(k);
    });
    skippedSeen = items.length - fresh.length;
    if (fresh.length > 0) {
      items.length = 0;
      items.push(...fresh);
    } else if (skippedSeen > 0) {
      // Keep original items; mark as repeat digest.
      repeatNote = `ยังไม่มีข่าวใหม่จากแหล่งที่ติดตาม (เคยสรุปไปแล้ว ${skippedSeen} รายการ) — สรุปเรื่องเด่นซ้ำให้แทน`;
      trace("fetch", `📰 ไม่มีใหม่ · สรุปซ้ำจาก ${skippedSeen} รายการ`);
    }
  }

  if (items.length === 0) {
    return {
      stories: [],
      skipped,
      note:
        skippedSeen > 0
          ? `ข่าวใหม่ยังไม่มีครับ — สรุปไปแล้ว ${skippedSeen} รายการจากแหล่งที่ติดตาม (จะส่งเมื่อมีข่าวใหม่)`
          : "ยังไม่มีเนื้อหา — เชื่อม YouTube หรือเพิ่มแหล่งข่าว / เลือกหัวข้อ",
    };
  }

  items.sort((a, b) => (b.published || "").localeCompare(a.published || ""));

  const wantAll = !fast && isNewsCountAll(newsCount);
  const highlightN = wantAll
    ? NEWS_COUNT_ALL_CAP
    : Math.max(1, Math.min(fast ? Math.min(newsCount || 3, 3) : newsCount, 10));

  // Balance: topics/feeds first; YouTube at most 1–2 when mixed with other news
  const topicItems = items.filter((it) => it.fromTopic);
  const feedItems = items.filter((it) => !it.fromTopic && it.kind !== "youtube");
  const ytItems = items.filter((it) => it.kind === "youtube");
  // Always max 2 YouTube clips in a digest (even in "all" mode)
  const ytCap = YT_HARD_CAP;

  const dedupeKey = (it: DigestItem) => (it.link || it.title || "").toLowerCase();
  const takeUnique = (src: DigestItem[], n: number, seen: Set<string>): DigestItem[] => {
    const out: DigestItem[] = [];
    for (const it of src) {
      if (out.length >= n) break;
      const k = dedupeKey(it);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
    return out;
  };

  const seen = new Set<string>();
  let pool: DigestItem[] = [];
  if (wantAll) {
    // "ทั้งหมด" = topic/feed news + at most 2 YouTube (never 20 YouTube)
    const todayTopic = topicItems.filter((it) => isPublishedTodayBkk(it.published || ""));
    const todayFeed = feedItems.filter((it) => isPublishedTodayBkk(it.published || ""));
    const topicPool = todayTopic.length ? todayTopic : topicItems.slice(0, 16);
    const feedPool = todayFeed.length ? todayFeed : feedItems.slice(0, 8);
    pool = [
      ...takeUnique(topicPool, 16, seen),
      ...takeUnique(feedPool, 8, seen),
      ...takeUnique(ytItems, ytCap, seen),
    ].slice(0, NEWS_COUNT_ALL_CAP);
  } else {
    const topicQuota = Math.min(topicItems.length, Math.max(topicItems.length ? 1 : 0, highlightN - ytCap));
    const afterTopic = Math.max(0, highlightN - topicQuota);
    const feedQuota = Math.min(feedItems.length, afterTopic);
    const ytQuota = Math.min(ytCap, Math.max(0, highlightN - topicQuota - feedQuota));
    pool = [
      ...takeUnique(topicItems, Math.max(topicQuota, Math.min(topicItems.length, highlightN)), seen),
      ...takeUnique(feedItems, feedQuota, seen),
      ...takeUnique(ytItems, ytQuota, seen),
    ];
    // Fill shortfall from non-YouTube first; YouTube only up to ytCap
    if (pool.length < highlightN) {
      pool.push(...takeUnique([...topicItems, ...feedItems], highlightN - pool.length, seen));
    }
    if (pool.length < highlightN) {
      const ytAlready = pool.filter((p) => p.kind === "youtube").length;
      if (ytAlready < ytCap) {
        pool.push(...takeUnique(ytItems, Math.min(ytCap - ytAlready, highlightN - pool.length), seen));
      }
    }
    pool = pool.slice(0, highlightN);
  }

  // Final safety net
  {
    let yt = 0;
    pool = pool.filter((it) => {
      if (it.kind !== "youtube") return true;
      if (yt >= ytCap) return false;
      yt++;
      return true;
    });
  }

  if (!pool.length) {
    return {
      stories: [],
      skipped,
      note: "วันนี้ยังไม่มีข่าว/คลิปใหม่จากแหล่งที่คุณติดตาม",
    };
  }

  // 3) pick highlights within the balanced pool
  let picks: number[] = [];
  if (fast || wantAll || pool.length <= highlightN) {
    picks = pool.map((_, i) => i).slice(0, highlightN);
  } else {
    const listing = pool
      .map((it, i) => {
        const tag = it.fromTopic ? " [หัวข้อ]" : it.kind === "youtube" ? " [YouTube]" : it.feedLabel === newestLabel ? " [ใหม่]" : "";
        const teaser = (it.summary || "").replace(/\s+/g, " ").trim().slice(0, 120);
        return `${i}.${tag} [${it.feedLabel}] ${it.title}${teaser ? ` — ${teaser}` : ""}`;
      })
      .join("\n");
    try {
      trace("fetch", `📰 เลือกเด่น · ${Math.min(highlightN, pool.length)} เรื่อง`, "start");
      const raw = await summaryChat(
        `คุณเป็นบรรณาธิการข่าว — เลือกข่าว/คลิปที่ "เด่น สำคัญ หรือน่าสนใจที่สุด" ${Math.min(highlightN, pool.length)} อัน\n` +
          `ตอบ JSON เท่านั้น {"highlights":[index...]}\n` +
          `เลือกเรื่องที่มีประเด็นชัด มีผลกระทบ มีตัวเลข/เหตุการณ์เด่น หรือน่าติดตาม — ไม่ใช่แค่หัวข้อทั่วไป\n` +
          `ให้ความสำคัญกับรายการที่มีแท็ก [หัวข้อ] ก่อน — YouTube เลือกได้ไม่เกิน ${ytCap} อัน`,
        listing,
        { json: true, temperature: 0, timeoutMs: 15000, traceStep: "fetch", tracePrefix: "📰 เลือกเด่น" }
      );
      const d = JSON.parse(raw);
      picks = [...(d.highlights || [])].filter(
        (n: unknown) => typeof n === "number" && n >= 0 && n < pool.length
      );
      trace("fetch", `📰 เลือกเด่น · ได้ ${picks.length} เรื่อง`);
    } catch {
      picks = [];
    }
    if (picks.length === 0) picks = pool.map((_, i) => i);
    // Enforce YouTube cap after LLM pick
    const chosenIdx: number[] = [];
    let ytPicked = 0;
    for (const i of picks) {
      if (chosenIdx.length >= highlightN) break;
      if (pool[i]?.kind === "youtube") {
        if (ytPicked >= ytCap) continue;
        ytPicked++;
      }
      chosenIdx.push(i);
    }
    for (let i = 0; i < pool.length && chosenIdx.length < highlightN; i++) {
      if (chosenIdx.includes(i)) continue;
      if (pool[i]?.kind === "youtube" && ytPicked >= ytCap) continue;
      if (pool[i]?.kind === "youtube") ytPicked++;
      chosenIdx.push(i);
    }
    picks = chosenIdx.slice(0, highlightN);
  }

  // 4) fetch article / YouTube captions + stage 2 — write useful Thai key points
  const chosen = picks.map((i) => pool[i]).slice(0, highlightN);
  trace("fetch", `📰 อ่านบทความ · ${chosen.length} เรื่อง`, "start");
  const scrapeMs = fast ? 8000 : 15000;

  // YouTube not in the final pick list — used as replacements when captions fail
  const chosenKeys = new Set(chosen.map((it) => (it.link || it.title || "").toLowerCase()).filter(Boolean));
  const ytSpare: DigestItem[] = ytItems.filter((it) => {
    const k = (it.link || it.title || "").toLowerCase();
    return k && !chosenKeys.has(k);
  });

  async function loadYtBody(it: DigestItem): Promise<string> {
    if (fast) {
      // Morning cron: description only (captions too slow). Thin desc → try next clip.
      return [it.title, it.summary].filter(Boolean).join("\n").slice(0, 4000);
    }
    return youtube.buildVideoBody({
      title: it.title,
      summary: it.summary,
      videoId: it.videoId,
      link: it.link,
    });
  }

  /** Try primary clip, then up to YT_REPLACE_MAX alternates; skip slot if all fail. */
  async function resolveYoutube(it: DigestItem): Promise<(DigestItem & { full: string }) | null> {
    let cur = it;
    let replacements = 0;
    const tried = new Set<string>();
    while (true) {
      const key = (cur.link || cur.title || "").toLowerCase();
      if (key) tried.add(key);
      const full = await loadYtBody(cur);
      if (youtube.isUsableVideoBody(full, cur.title)) {
        if (replacements > 0) {
          trace("fetch", `📰 YouTube · ใช้คลิปแทน #${replacements} · ${(cur.title || "").slice(0, 40)}`);
        }
        return { ...cur, full };
      }
      if (replacements >= YT_REPLACE_MAX) {
        skipped.push(`YouTube · ข้าม (ลอง ${replacements + 1} คลิปแล้วยังไม่มีซับ/สรุปไม่ได้)`);
        trace("fetch", `📰 YouTube · ข้ามหลังลอง ${replacements + 1} คลิป`, "error");
        return null;
      }
      const nextIdx = ytSpare.findIndex((s) => {
        const k = (s.link || s.title || "").toLowerCase();
        return k && !tried.has(k);
      });
      if (nextIdx < 0) {
        skipped.push(`YouTube · ข้าม (${(cur.title || "คลิป").slice(0, 40)} — ไม่มีคลิปสำรอง)`);
        trace("fetch", "📰 YouTube · ข้าม — หมดคลิปสำรอง", "error");
        return null;
      }
      const [next] = ytSpare.splice(nextIdx, 1);
      replacements += 1;
      trace(
        "fetch",
        `📰 YouTube · คลิปใช้ไม่ได้ · ลองแทน ${replacements}/${YT_REPLACE_MAX} · ${(next.title || "").slice(0, 36)}`
      );
      cur = next!;
    }
  }

  // News in parallel; YouTube sequential so spare clips aren't double-claimed
  type WithFull = DigestItem & { full: string; thin?: boolean };
  const resolved: (WithFull | null)[] = new Array(chosen.length).fill(null);
  // Articles whose body will not load (Cloudflare, paywalls) can only be
  // "summarised" back into their own headline — which is what a reader notices
  // first: «เหมือนเอาแค่หัวข้อมา». Try a spare story instead of shipping that.
  const NEWS_MIN_BODY = 400;
  const NEWS_REPLACE_MAX = 2;
  const chosenNewsKeys = new Set(
    chosen.map((it) => (it.link || it.title || "").toLowerCase()).filter(Boolean)
  );
  const newsSpare: DigestItem[] = pool.filter((it) => {
    const k = (it.link || it.title || "").toLowerCase();
    return it.kind !== "youtube" && k && !chosenNewsKeys.has(k);
  });

  // Judge on the ARTICLE, not on the assembled body: title + RSS blurb can clear
  // any length bar while carrying none of the substance the piece actually has.
  const readNews = async (it: DigestItem): Promise<{ full: string; article: number }> => {
    const sum = (it.summary || "").trim();
    const scraped = await fetchArticle(it.link, scrapeMs);
    let full = bestArticleBody(it.title, isPaywalledSnippet(sum) ? "" : sum, scraped);
    if (isPaywalledSnippet(full)) full = (it.title || "").trim();
    return { full, article: isPaywalledSnippet(scraped) ? 0 : scraped.length };
  };

  await Promise.all(
    chosen.map(async (it, i) => {
      if (it.kind === "youtube") return;
      let cur = it;
      let read = await readNews(cur);
      for (let tries = 0; read.article < NEWS_MIN_BODY && tries < NEWS_REPLACE_MAX; tries++) {
        const next = newsSpare.shift();
        if (!next) break;
        trace(
          "fetch",
          `📰 อ่านบทความไม่ได้ · ${(cur.title || "").slice(0, 30)} → ลองเรื่องอื่น`,
          "error"
        );
        cur = next;
        read = await readNews(cur);
      }
      resolved[i] = { ...cur, full: read.full, thin: read.article < NEWS_MIN_BODY };
    })
  );
  for (let i = 0; i < chosen.length; i++) {
    if (chosen[i]!.kind !== "youtube") continue;
    resolved[i] = await resolveYoutube(chosen[i]!);
  }
  // A story whose article will not load can only be written back into its own
  // headline. Drop it rather than shipping a summary that summarises nothing —
  // fewer, real stories beat a full list padded with restated headlines.
  const readable = resolved.filter((x): x is WithFull => !!x);
  const unreadable = readable.filter((x) => x.thin);
  const withText = readable.filter((x) => !x.thin);
  for (const it of unreadable) {
    skipped.push(`${it.feedLabel || "ข่าว"} · ข้าม (เว็บต้นทางไม่ให้ดึงเนื้อหา: ${(it.title || "").slice(0, 40)})`);
  }
  if (unreadable.length) {
    trace("fetch", `📰 ข้าม ${unreadable.length} เรื่อง · อ่านต้นฉบับไม่ได้`);
  }
  trace("fetch", `📰 อ่านบทความ · ${withText.length} เรื่อง`);
  type StorySummary = { headline?: string; points?: string[]; blurb?: string; bullets?: string[] };
  const summaries: Record<string, StorySummary> = {};

  const similarToTitle = (text: string, title: string) => {
    const a = text.toLowerCase().replace(/\s+/g, "");
    const b = title.toLowerCase().replace(/\s+/g, "");
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 12 && (b.includes(a) || a.includes(b))) return true;
    // Rough overlap: >60% of title tokens appear in headline
    const tokens = title.split(/\s+/).filter((t) => t.length > 1);
    if (tokens.length < 3) return false;
    const hit = tokens.filter((t) => text.includes(t)).length;
    return hit / tokens.length >= 0.7;
  };

  const NEWS_WRITER_SYSTEM =
    "คุณเป็นบรรณาธิการสรุปข่าวให้หัวหน้าอ่านบน LINE เป็นภาษาไทย\n" +
    "เป้าหมาย: อ่านแล้วรู้ว่าเกิดอะไร สำคัญยังไง มีตัวเลข/ผลกระทบอะไร — ห้ามแค่เขียนหัวข่าวใหม่\n" +
    "ตอบ JSON เท่านั้น โดยใช้เลขตาม # ที่ให้มา:\n" +
    '{"0":{"headline":"...","points":["...","..."]},"1":{...}}\n' +
    "กติกา:\n" +
    "- ทุกฟิลด์เป็นภาษาไทย (ยกเว้นชื่อเฉพาะ/ตัวเลข)\n" +
    "- headline = 1 ประโยค สรุปเหตุการณ์จริงจากเนื้อหา + ทำไมควรรู้ (ห้ามคัดลอก/พาราเฟรสหัวข้อข่าว)\n" +
    "- points = 3–5 ข้อ จากเนื้อหา: ข้อเท็จจริง ตัวเลข สาเหตุ/ผลกระทบ สิ่งที่ต้องจับตา\n" +
    "- แต่ละ point เป็นประโยคสมบูรณ์ มีสาระ ไม่ซ้ำ headline และไม่ใช่ประโยคกลางๆ\n" +
    "- ถ้าเนื้อหายาวพอ ห้ามสรุปสั้นเหลือ 1–2 บรรทัดลอยๆ\n" +
    "- ห้ามเขียนว่า “ไม่มีรายละเอียด…” “ไม่ระบุ…” เด็ดขาด\n" +
    "- ห้ามแต่งตัวเลข/เหตุการณ์ที่ไม่มีในเนื้อหา";

  const YT_WRITER_SYSTEM =
    "คุณสรุปคลิป YouTube ให้หัวหน้าอ่านบน LINE เป็นภาษาไทย\n" +
    "เป้าหมาย: อ่านแล้วรู้ว่าคลิปนี้พูด/เล่า/โชว์อะไร เป็นเรื่องเกี่ยวกับอะไร โดยไม่ต้องเปิดดู\n" +
    "ตอบ JSON เท่านั้น:\n" +
    '{"0":{"headline":"...","points":["...","..."]}}\n' +
    "กติกา:\n" +
    "- ใช้ถอดเสียง/ซับไตเติลเป็นหลัก ถ้ามี — คำบรรยายเป็นข้อมูลเสริม\n" +
    "- headline = คลิปนี้เกี่ยวกับอะไรใน 1 ประโยค (ห้ามคัดลอกชื่อคลิป)\n" +
    "- points = 3–5 ข้อ: ประเด็นหลักที่พูดในคลิป ข้อเท็จจริง/ตัวอย่างที่ยก มุมสรุปท้ายคลิป\n" +
    "- ห้ามสรุปเป็นแค่ชื่อช่อง/โปรโมต/ลิงก์โซเชียล\n" +
    "- ถ้ามีแค่ชื่อคลิป: บอกตรงๆ ใน headline ว่าข้อมูลไม่พอสรุปสาระ แล้ว points 1 ข้อจากชื่อเท่านั้น\n" +
    "- ห้ามเดาสาระที่ไม่มีในถอดเสียง/คำบรรยาย";

  async function summarizeBatch(
    items: { it: (typeof withText)[number]; i: number }[],
    system: string,
    quality: boolean
  ) {
    if (!items.length) return;
    const writerInput = items
      .map(({ it, i }) => {
        const body = (it.full || it.summary || it.title || "").slice(0, 6500);
        const thin = body.trim().length < 160 || body.trim() === (it.title || "").trim();
        const kindHint =
          it.kind === "youtube"
            ? "ชนิด: คลิป YouTube\n"
            : "ชนิด: ข่าว/บทความ — สรุปสาระข่าว ไม่ใช่หัวข้อ\n";
        return (
          `#${i}\n${kindHint}หัวข้อต้นทาง: ${it.title}\nแหล่ง: ${it.feedLabel}\n` +
          (thin ? "หมายเหตุ: เนื้อหาบางมาก — ห้ามแต่ง ห้ามพาราเฟรสหัวข้อให้ดูดี\n" : "") +
          `เนื้อหา:\n${body}`
        );
      })
      .join("\n\n----\n\n");
    try {
      trace("compose", `📰 สรุปประเด็น · ${items.length} เรื่อง`, "start");
      const raw = await summaryChat(system, writerInput, {
        json: true,
        temperature: 0.2,
        timeoutMs: quality ? 28000 : 14000,
        traceStep: "compose",
        tracePrefix: "📰 สรุปประเด็น",
      });
      const parsed = JSON.parse(raw) as Record<string, StorySummary>;
      Object.assign(summaries, parsed);
      trace("compose", `📰 สรุปประเด็น · ${items.length} เรื่อง ✓`);
    } catch (e) {
      // Still deliver news with title/snippet later — mark WRITER clearly, don't look "alive".
      trace(
        "compose",
        `📰 สรุปประเด็น · AI ล้ม · ใช้ข้อความดิบแทน (${String(e).slice(0, 80)})`,
        "error"
      );
    }
  }

  // YouTube alone (captions need full attention); news in pairs with real indices.
  const ytRows = withText
    .map((it, i) => ({ it, i }))
    .filter((x) => x.it.kind === "youtube");
  const newsRows = withText
    .map((it, i) => ({ it, i }))
    .filter((x) => x.it.kind !== "youtube");

  if (fast) {
    // Morning: still use quality writer once (readable LINE). Speed comes from
    // skipping Facebook / YouTube captions / repair loops — not from bad summaries.
    for (let n = 0; n < newsRows.length; n += 2) {
      await summarizeBatch(newsRows.slice(n, n + 2), NEWS_WRITER_SYSTEM, true);
    }
    for (const row of ytRows) {
      await summarizeBatch([row], YT_WRITER_SYSTEM, true);
    }
  } else {
    for (const row of ytRows) {
      await summarizeBatch([row], YT_WRITER_SYSTEM, true);
      const s = summaries[String(row.i)];
      const hl = String(s?.headline || "").trim();
      if (s && similarToTitle(hl, row.it.title)) {
        await summarizeBatch(
          [row],
          YT_WRITER_SYSTEM + "\n\nรอบแก้: headline ห้ามคล้ายชื่อคลิป — บอกสาระจากถอดเสียงให้ชัด",
          true
        );
      }
    }

    for (let n = 0; n < newsRows.length; n += 2) {
      const chunk = newsRows.slice(n, n + 2);
      await summarizeBatch(chunk, NEWS_WRITER_SYSTEM, true);
    }

    // Repair weak news summaries (title echo / too thin vs body length)
    for (const row of newsRows) {
      const s = summaries[String(row.i)];
      const hl = String(s?.headline || "").trim();
      const pts = (s?.points || s?.bullets || []).filter((b) => String(b || "").trim());
      const bodyLen = (row.it.full || row.it.summary || "").length;
      const weak = !hl || similarToTitle(hl, row.it.title) || (bodyLen > 400 && pts.length < 2);
      if (weak) {
        await summarizeBatch(
          [row],
          NEWS_WRITER_SYSTEM +
            "\n\nรอบแก้: ห้ามเขียนคล้ายหัวข้อ — ต้องบอกว่าเกิดอะไร มีใครเกี่ยวข้อง ตัวเลข/ผลกระทบจากเนื้อหา อย่างน้อย 3 points",
          true
        );
      }
    }
  }

  // 5) build stories
  const stories: Story[] = [];
  for (let i = 0; i < withText.length; i++) {
    const it = withText[i];
    const s = summaries[String(i)] || {};
    const headline = cleanBullet(String(s.headline || s.blurb || ""));
    const points = (s.points || s.bullets || [])
      .map((b) => cleanBullet(String(b || "")))
      .filter((b) => b && !isHollowBullet(b) && !isTruncatedGarbage(b));
    let finalBullets = [headline, ...points].filter((b) => b && !isHollowBullet(b) && !isTruncatedGarbage(b)).slice(0, 6);
    if (!finalBullets.length) {
      // Prefer 2–3 complete sentences from body — never hard-slice mid-word.
      const raw = cleanBullet(it.summary || it.full || it.title || "");
      const sentences = raw.split(/(?<=[.!?。])\s+/).filter((x) => x.trim().length > 12);
      if (sentences.length >= 2) {
        finalBullets = sentences.slice(0, 3).map((x) => clipComplete(x, 200));
      } else {
        const snip = clipComplete(raw, 280);
        finalBullets = snip && snip !== it.title ? [snip] : [(it.title || "").trim()].filter(Boolean);
      }
    }
    // Cap each bullet length at a complete boundary (LINE readability).
    finalBullets = finalBullets.map((b) => clipComplete(b, 280)).filter(Boolean);
    stories.push({
      id: createHash("sha1").update(it.link).digest("hex").slice(0, 8),
      title: it.title,
      source: it.feedLabel,
      kind: it.kind as Story["kind"],
      bullets: finalBullets,
      whatHappened: finalBullets[0] || "",
      cause: finalBullets[1] || "",
      progress: finalBullets[2] || "",
      conclusion: finalBullets[3] || "",
      shortLink: it.link,
      rawLink: it.link,
      publishedAt: it.published || "",
      thin: !!(it as { thin?: boolean }).thin,
    });
  }

  trace("compose", `📰 สรุปเสร็จ · ${stories.length} เรื่องเด่น`);
  return { stories, skipped, note: repeatNote };
}

/** User-facing footnote for skipped feeds — hide when digest already has stories. */
export function formatDigestSkippedNote(skipped: string[], hasStories: boolean): string {
  if (!skipped.length || hasStories) return "";
  const short = skipped
    .map((s) => {
      const name = (s.split(" (")[0] || s).trim();
      if (/facebook/i.test(s)) return `${name} (ตั้งเป็นแหล่ง Facebook)`;
      if (/youtube/i.test(s)) return `${name} (เชื่อม Google ที่หน้าตั้งค่า)`;
      return name;
    })
    .slice(0, 3);
  const more = skipped.length > short.length ? ` +${skipped.length - short.length}` : "";
  return `\n\n(ดึงไม่ได้บางแหล่ง: ${short.join(", ")}${more})`;
}

/** Call after a digest was shown/pushed so the same links are not summarized again. */
export async function rememberDeliveredStories(upn: string, stories: Story[]): Promise<void> {
  const { markNewsStoriesSeen } = await import("@/lib/store");
  await markNewsStoriesSeen(upn, stories);
}
