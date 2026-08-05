// Shared news-digest builder — used by the /api/digest route AND the chat/LINE
// command handler ("มีข่าวอะไรบ้าง"). Pulls the user's granted feeds + YouTube
// subscriptions, picks highlights, and writes natural Thai bullet summaries.
import { createHash } from "crypto";
import { admin } from "@/lib/supabaseServer";
import { fetchFeed, fetchArticle, type FeedEntry } from "@/lib/rss";
import { recentPosts as facebookPosts } from "@/lib/facebook";
import { chat } from "@/lib/llm";
import { getNewsCount, isNewsCountAll, NEWS_COUNT_ALL_CAP } from "@/lib/notify";
import { nowWall, TZ_OFFSET_MIN } from "@/lib/time";
import { loadSeenNewsKeys, newsStoryKey } from "@/lib/store";
import { trace } from "@/lib/trace";
import * as youtube from "@/lib/youtube";

/** Trial: force Gemini for news pick + summarize. Set null to restore default chain. */
const NEWS_LLM_PREFER: "gemini" | "qwen" | "groq" | null = null;

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
export function formatStoriesText(stories: Story[]): string {
  const n = stories.length;
  const lines = [`📰 ข่าววันนี้ · ${n} เรื่องเด่น`, ""];
  stories.forEach((s, i) => {
    const bullets = storyBullets(s).map((b) => b.trim()).filter((b) => b && !isHollowBullet(b));
    const headline = bullets[0] || s.title;
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

export async function buildDigest(upn: string): Promise<DigestResult> {
  trace("fetch", "📰 เริ่มรวบรวมข่าว", "start");
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
        const fbLabel = (f.label || "Facebook").slice(0, 60);
        trace("fetch", `📰 Facebook · ${fbLabel}`, "start");
        try {
          const entries = await facebookPosts(f.ref, 8);
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

  // 2b) YouTube — pull uploads; hard-cap to 2 newest in digest (never flood)
  const YT_HARD_CAP = 2;
  if (granted.has("src_youtube") && youtube.isConfigured()) {
    const { data: tok } = await admin.from("oauth_tokens").select("refresh_token").eq("owner_upn", upn).eq("provider", "google").single();
    if (tok?.refresh_token) {
      try {
        trace("fetch", "📰 YouTube · subscriptions", "start");
        const vids = await youtube.recentUploads(tok.refresh_token);
        trace("fetch", `📰 YouTube · subscriptions · ${Math.min(vids.length, YT_HARD_CAP)} คลิป`);
        vids
          .sort((a, b) => (b.published || "").localeCompare(a.published || ""))
          .slice(0, YT_HARD_CAP)
          .forEach((v) =>
            items.push({
              title: v.title,
              link: v.link,
              published: v.published,
              summary: v.summary,
              source: v.source,
              kind: "youtube",
              feedLabel: v.source,
              videoId: v.videoId,
            })
          );
      } catch (e) {
        skipped.push(`YouTube (ดึงไม่สำเร็จ: ${String(e).slice(0, 60)})`);
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

  // Skip stories already summarized for this user (push or “มีข่าวอะไรบ้าง”)
  const seenKeys = await loadSeenNewsKeys(upn);
  let skippedSeen = 0;
  if (seenKeys.size) {
    const fresh = items.filter((it) => {
      const k = newsStoryKey(it.link || "", it.title || "");
      return !k || !seenKeys.has(k);
    });
    skippedSeen = items.length - fresh.length;
    items.length = 0;
    items.push(...fresh);
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

  const wantAll = isNewsCountAll(newsCount);
  const highlightN = wantAll
    ? NEWS_COUNT_ALL_CAP
    : Math.max(1, Math.min(newsCount, 10));

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
  if (wantAll || pool.length <= highlightN) {
    picks = pool.map((_, i) => i);
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
      const raw = await chat(
        `คุณเป็นบรรณาธิการข่าว — เลือกข่าว/คลิปที่ "เด่น สำคัญ หรือน่าสนใจที่สุด" ${Math.min(highlightN, pool.length)} อัน\n` +
          `ตอบ JSON เท่านั้น {"highlights":[index...]}\n` +
          `เลือกเรื่องที่มีประเด็นชัด มีผลกระทบ มีตัวเลข/เหตุการณ์เด่น หรือน่าติดตาม — ไม่ใช่แค่หัวข้อทั่วไป\n` +
          `ให้ความสำคัญกับรายการที่มีแท็ก [หัวข้อ] ก่อน — YouTube เลือกได้ไม่เกิน ${ytCap} อัน`,
        listing,
        { json: true, temperature: 0, timeoutMs: 15000, prefer: NEWS_LLM_PREFER || undefined, traceStep: "fetch", tracePrefix: "📰 เลือกเด่น" }
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
  const withText = await Promise.all(
    chosen.map(async (it) => {
      if (it.kind === "youtube") {
        const full = await youtube.buildVideoBody({
          title: it.title,
          summary: it.summary,
          videoId: it.videoId,
          link: it.link,
        });
        return { ...it, full };
      }
      // Always scrape the article page — RSS/NewsData teasers alone make weak summaries.
      const sum = (it.summary || "").trim();
      const scraped = await fetchArticle(it.link);
      let full = bestArticleBody(it.title, isPaywalledSnippet(sum) ? "" : sum, scraped);
      if (isPaywalledSnippet(full)) full = (it.title || "").trim();
      return { ...it, full };
    })
  );
  trace("fetch", `📰 อ่านบทความ · ${withText.length} เรื่อง`);
  type StorySummary = { headline?: string; points?: string[]; blurb?: string; bullets?: string[] };
  const summaries: Record<string, StorySummary> = {};
  // Smaller batches = less detail loss; YouTube alone so captions get full attention.
  const BATCH = 2;
  for (let offset = 0; offset < withText.length; offset += BATCH) {
    const batch = withText.slice(offset, offset + BATCH);
    const writerInput = batch
      .map((it, j) => {
        const globalIdx = offset + j;
        const body = (it.full || it.summary || it.title || "").slice(0, 6000);
        const thin = body.trim().length < 120 || body.trim() === (it.title || "").trim();
        const kindHint =
          it.kind === "youtube"
            ? "ชนิด: คลิป YouTube — สรุปจากคำบรรยาย/ซับไตเติลว่าคลิปพูดถึงอะไร จุดเด่นคืออะไร\n"
            : "ชนิด: ข่าว/บทความ\n";
        return (
          `#${globalIdx}\n${kindHint}หัวข้อ: ${it.title}\nแหล่ง: ${it.feedLabel}\n` +
          (thin ? "หมายเหตุ: เนื้อหาสั้น — สรุปเท่าที่มีอย่างตรงไปตรงมา ห้ามแต่งเติม\n" : "") +
          `เนื้อหา: ${body}`
        );
      })
      .join("\n\n");
    try {
      trace("compose", `📰 สรุปประเด็น · ${batch.length} เรื่อง`, "start");
      const raw = await chat(
        "คุณเป็นบรรณาธิการสรุปข่าว/คลิปให้หัวหน้าอ่านบน LINE เป็นภาษาไทย\n" +
          "เป้าหมาย: อ่านแล้วรู้เรื่องทันที — ไม่ใช่พาราเฟรสหัวข้อ และไม่ใช่ประโยคกลางๆ ที่เลื่อนลอย\n" +
          "ตอบ JSON เท่านั้น โดยใช้เลขตาม # ที่ให้มา:\n" +
          '{"0":{"headline":"...","points":["...","..."]},"1":{...}}\n' +
          "กติกา:\n" +
          "- ทุกฟิลด์ต้องเป็นภาษาไทย (ยกเว้นชื่อเฉพาะ/ตัวเลข/ชื่อช่อง)\n" +
          "- headline = 1 ประโยค บอกสาระหลักว่าเกิดอะไร + ทำไมควรรู้ (ห้ามคัดลอกหัวข้อดิบ)\n" +
          "- points = 3–5 ข้อ ดึงข้อเท็จจริง ตัวเลข ผลกระทบ มุมที่ควรจับตา จากเนื้อหา\n" +
          "- แต่ละ point เป็นประโยคสมบูรณ์ อ่านแล้วได้ข้อมูล ไม่ซ้ำ headline\n" +
          "- คลิป YouTube: สรุปว่าคลิปพูด/โชว์อะไร ไม่ใช่แค่ชื่อคลิป หรือคำโฆษณาในคำบรรยาย\n" +
          "- ห้ามเขียนว่า “ไม่มีรายละเอียด…” “ไม่ระบุ…” “เนื้อหาไม่ได้บอก…” เด็ดขาด\n" +
          "- ข้อมูลน้อย → headline สั้น + points 1–2 ข้อจากที่มี — ห้ามแต่งตัวเลข/เหตุการณ์",
        writerInput,
        {
          json: true,
          temperature: 0.25,
          timeoutMs: 20000,
          prefer: NEWS_LLM_PREFER || undefined,
          // Prefer Groq-fast when no explicit prefer — LINE digest must finish.
          fast: !NEWS_LLM_PREFER,
          traceStep: "compose",
          tracePrefix: "📰 สรุปประเด็น",
        }
      );
      const parsed = JSON.parse(raw) as Record<string, StorySummary>;
      Object.assign(summaries, parsed);
      trace("compose", `📰 สรุปประเด็น · ${batch.length} เรื่อง ✓`);
    } catch {
      /* keep whatever we have; fallbacks below */
    }
  }

  // 5) build stories
  const stories: Story[] = [];
  for (let i = 0; i < withText.length; i++) {
    const it = withText[i];
    const s = summaries[String(i)] || {};
    const headline = String(s.headline || s.blurb || "").trim();
    const points = (s.points || s.bullets || [])
      .map((b) => String(b || "").trim())
      .filter((b) => b && !isHollowBullet(b));
    let finalBullets = [headline, ...points].filter((b) => b && !isHollowBullet(b)).slice(0, 6);
    if (!finalBullets.length) {
      const snip = (it.summary || it.full || "").replace(/\s+/g, " ").trim().slice(0, 220);
      finalBullets = snip && snip !== it.title ? [snip] : [(it.title || "").trim()].filter(Boolean);
    }
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
    });
  }

  trace("compose", `📰 สรุปเสร็จ · ${stories.length} เรื่องเด่น`);
  return { stories, skipped };
}

/** Call after a digest was shown/pushed so the same links are not summarized again. */
export async function rememberDeliveredStories(upn: string, stories: Story[]): Promise<void> {
  const { markNewsStoriesSeen } = await import("@/lib/store");
  await markNewsStoriesSeen(upn, stories);
}
