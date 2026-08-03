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
import { getSetting } from "@/lib/store";
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

/** Render stories as a natural bullet digest (for LINE push and chat). */
export function formatStoriesText(stories: Story[]): string {
  const lines = ["📰 สรุปข่าวที่คุณติดตามวันนี้", "อ่านจบในแชทได้เลย — ไม่ต้องเปิดลิงก์ก็รู้เรื่อง", ""];
  stories.forEach((s, i) => {
    const bullets = storyBullets(s).slice(0, 4);
    const gist = bullets[0] || s.title;
    const rest = bullets.slice(1);
    lines.push(`${i + 1}) ${s.source}`);
    lines.push(`   📌 ${gist}`);
    for (const b of rest) {
      lines.push(`   • ${b}`);
    }
    if (s.title && s.title !== gist && !gist.includes(s.title.slice(0, 20))) {
      lines.push(`   (หัวข้อเดิม: ${s.title.slice(0, 80)})`);
    }
    if (s.rawLink) lines.push(`   🔗 อ่านเต็ม: ${s.rawLink}`);
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
  type DigestItem = FeedEntry & { kind: string; feedLabel: string; fromTopic?: boolean };
  const items: DigestItem[] = [];
  const skipped: string[] = [];

  const newsCount = await getNewsCount(upn);

  // 2a) manually-added feeds (RSS + Facebook pages)
  for (const f of feeds) {
    if (!granted.has(CAP_BY_KIND[f.kind])) {
      skipped.push(`${f.label || f.kind} (ไม่ได้อนุญาตแหล่งชนิด ${f.kind})`);
      continue;
    }
    if (f.kind === "rss") {
      // Facebook share URLs mis-saved as RSS won't parse — skip with a hint
      if (/facebook\.com/i.test(f.ref || "")) {
        skipped.push(`${f.label || "RSS"} (ลิงก์เป็น Facebook — เพิ่มเป็นแหล่ง Facebook หรือเปิดสิทธิ์ Facebook)`);
        continue;
      }
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

  // 2b) YouTube — auto-pull subscriptions (capped later so it won't drown topic news)
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

  // 2c) Topic interests — NewsData keyword search for user-selected topics
  {
    const { getNewsPrefs, topicQuery } = await import("@/lib/newsPrefs");
    const prefs = await getNewsPrefs(upn);
    if (prefs.interested && prefs.topics.length) {
      try {
        const { isNewsDataConfigured, fetchNewsByTopic } = await import("@/lib/newsdata");
        if (isNewsDataConfigured()) {
          for (const topic of prefs.topics.slice(0, 6)) {
            try {
              const entries = await fetchNewsByTopic(topicQuery(topic), 4);
              entries.forEach((e) =>
                items.push({
                  ...e,
                  kind: "rss",
                  feedLabel: `หัวข้อ · ${topic}`,
                  fromTopic: true,
                  summary: e.summary || e.title,
                })
              );
            } catch (e) {
              skipped.push(`หัวข้อ “${topic}” (${String(e).slice(0, 60)})`);
            }
          }
        } else {
          skipped.push("หัวข้อข่าว (ยังไม่ได้ตั้ง NEWSDATA_API_KEY)");
        }
      } catch (e) {
        skipped.push(`หัวข้อข่าว (${String(e).slice(0, 60)})`);
      }
    }
  }

  if (items.length === 0) {
    return { stories: [], skipped, note: "ยังไม่มีเนื้อหา — เชื่อม YouTube หรือเพิ่มแหล่งข่าว / เลือกหัวข้อ" };
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
  const hasNonYt = topicItems.length + feedItems.length > 0;
  const ytCap = hasNonYt ? 2 : Math.min(5, highlightN);

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
    // Prefer today's topic + feed news; always keep recent topics even if "today" filter is strict
    const todayTopic = topicItems.filter((it) => isPublishedTodayBkk(it.published || ""));
    const todayFeed = feedItems.filter((it) => isPublishedTodayBkk(it.published || ""));
    const todayYt = ytItems.filter((it) => isPublishedTodayBkk(it.published || ""));
    const topicPool = todayTopic.length ? todayTopic : topicItems.slice(0, 12);
    const feedPool = todayFeed.length ? todayFeed : feedItems.slice(0, 8);
    pool = [
      ...takeUnique(topicPool, 12, seen),
      ...takeUnique(feedPool, 8, seen),
      ...takeUnique(todayYt.length ? todayYt : ytItems, ytCap, seen),
    ].slice(0, NEWS_COUNT_ALL_CAP);
  } else {
    // Fixed count: reserve most slots for topics, then feeds, then ≤2 YouTube
    const topicQuota = Math.min(topicItems.length, Math.max(1, highlightN - (hasNonYt ? Math.min(ytCap, 1) : 0)));
    const afterTopic = Math.max(0, highlightN - topicQuota);
    const feedQuota = Math.min(feedItems.length, afterTopic);
    const ytQuota = Math.min(ytCap, Math.max(0, highlightN - topicQuota - feedQuota));
    pool = [
      ...takeUnique(topicItems, topicQuota || Math.min(topicItems.length, highlightN), seen),
      ...takeUnique(feedItems, feedQuota, seen),
      ...takeUnique(ytItems, ytQuota, seen),
    ];
    // If still short (e.g. topics failed), fill from remaining non-YT then YT
    if (pool.length < highlightN) {
      pool.push(...takeUnique([...topicItems, ...feedItems, ...ytItems], highlightN - pool.length, seen));
    }
    pool = pool.slice(0, highlightN);
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
        return `${i}.${tag} [${it.feedLabel}] ${it.title}`;
      })
      .join("\n");
    try {
      const raw = await chat(
        `เลือกข่าวเด่น ${Math.min(highlightN, pool.length)} อัน ตอบ JSON เท่านั้น {"highlights":[index...]}\n` +
          `สำคัญ: ให้ความสำคัญกับรายการที่มีแท็ก [หัวข้อ] ก่อน — YouTube เลือกได้ไม่เกิน ${ytCap} อัน`,
        listing,
        { json: true, temperature: 0 }
      );
      const d = JSON.parse(raw);
      picks = [...(d.highlights || [])].filter(
        (n: unknown) => typeof n === "number" && n >= 0 && n < pool.length
      );
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

  // 4) fetch article text + stage 2 — natural bullet summaries (batch for quality)
  const chosen = picks.map((i) => pool[i]);
  const withText = await Promise.all(
    chosen.map(async (it) => ({ ...it, full: (await fetchArticle(it.link)) || it.summary }))
  );
  const summaries: Record<string, { bullets?: string[]; points?: string[] }> = {};
  const BATCH = 5;
  for (let offset = 0; offset < withText.length; offset += BATCH) {
    const batch = withText.slice(offset, offset + BATCH);
    const writerInput = batch
      .map((it, j) => {
        const globalIdx = offset + j;
        const body = (it.full || it.summary || it.title || "").slice(0, 4000);
        return `#${globalIdx}\nหัวข้อ: ${it.title}\nแหล่ง: ${it.feedLabel}\nเนื้อหา: ${body}`;
      })
      .join("\n\n");
    try {
      const raw = await chat(
        "คุณเป็นบรรณาธิการสรุปข่าวให้ผู้บริหารอ่านบน LINE มือถือ — สรุปให้เข้าใจเนื้อหาโดยไม่ต้องเปิดลิงก์\n" +
          "ตอบ JSON เท่านั้น โดยใช้เลข index ตาม # ที่ให้มา:\n" +
          '{"0":{"bullets":["...","...","..."]}, "1":{...}}\n' +
          "กติกาสำคัญ:\n" +
          "- แต่ละข่าวมี 3–4 bullets เป็นภาษาไทย อ่านง่าย\n" +
          "- bullet แรกต้องตอบว่า “เรื่องนี้พูดถึงอะไร” ใน 1 ประโยคชัดเจน (ใคร/ทำอะไร/ผลลัพธ์หรือประเด็นหลัก)\n" +
          "- bullet ถัดไป = รายละเอียดสำคัญ / ตัวเลข / ผลกระทบ / สิ่งที่ควรรู้ต่อ\n" +
          "- ห้ามแค่ถอดหัวข้อข่าวมาวาง ห้ามคลุมเครือแบบ “มีความคืบหน้า” โดยไม่อธิบายว่าอะไร\n" +
          "- ห้ามใช้ป้าย เกิดอะไรขึ้น/สาเหตุ/สรุป\n" +
          "- สรุปจากเนื้อหาที่ให้เท่านั้น ห้ามแต่ง — ถ้าเนื้อหาน้อย ให้สรุปเท่าที่มีอย่างตรงไปตรงมา",
        writerInput,
        { json: true, temperature: 0.3 }
      );
      const parsed = JSON.parse(raw) as Record<string, { bullets?: string[]; points?: string[] }>;
      Object.assign(summaries, parsed);
    } catch {
      /* keep whatever we have; fallbacks below */
    }
  }

  // 5) build stories
  const stories: Story[] = [];
  for (let i = 0; i < withText.length; i++) {
    const it = withText[i];
    const s = summaries[String(i)] || {};
    const bullets = (s.bullets || s.points || [])
      .map((b) => String(b || "").trim())
      .filter(Boolean)
      .slice(0, 5);
    const fallback = (it.summary || it.title || "").trim().slice(0, 220);
    const finalBullets = bullets.length ? bullets : fallback ? [fallback] : [];
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

  return { stories, skipped };
}
