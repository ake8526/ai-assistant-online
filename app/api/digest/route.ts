import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { fetchFeed, fetchArticle, type FeedEntry } from "@/lib/rss";
import { chat } from "@/lib/llm";

export const maxDuration = 60;

export interface Story {
  id: string;
  title: string;
  source: string;
  kind: "rss" | "youtube" | "facebook";
  whatHappened: string;
  cause: string;
  progress: string;
  conclusion: string;
  shortLink: string;
  rawLink: string;
  publishedAt: string;
}

const CAP_BY_KIND: Record<string, string> = { rss: "src_rss", youtube: "src_youtube", facebook: "src_facebook" };
const APP_BASE = process.env.NEXT_PUBLIC_APP_BASE_URL || "";

async function makeShortLink(upn: string, url: string, source: string, title: string): Promise<string> {
  const code = createHash("sha1").update(`${upn}|${url}`).digest("hex").slice(0, 10);
  await admin
    .from("read_links")
    .upsert(
      { code, owner_upn: upn, url, source, title: title.slice(0, 200), created_at: new Date().toISOString() },
      { onConflict: "code" }
    );
  return APP_BASE ? `${APP_BASE}/r/${code}` : url;
}

export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
    if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });

    // 1) consents + feeds
    const { data: consentRows } = await admin.from("consents").select("capability, granted").eq("owner_upn", upn);
    const granted = new Set((consentRows || []).filter((r) => r.granted).map((r) => r.capability));
    const { data: feeds } = await admin
      .from("feeds")
      .select("*")
      .eq("owner_upn", upn)
      .order("created_at", { ascending: true });
    if (!feeds || feeds.length === 0)
      return NextResponse.json({ ok: true, user: upn, count: 0, stories: [], note: "ยังไม่มีแหล่งข่าว" });

    const newestLabel = feeds[feeds.length - 1].label || "";

    // 2) gather items from consented RSS feeds (youtube/facebook: not yet on Vercel)
    const items: (FeedEntry & { kind: string; feedLabel: string })[] = [];
    const skipped: string[] = [];
    for (const f of feeds) {
      if (!granted.has(CAP_BY_KIND[f.kind])) {
        skipped.push(`${f.label || f.kind} (ไม่ได้อนุญาตแหล่งชนิด ${f.kind})`);
        continue;
      }
      if (f.kind === "rss") {
        const entries = await fetchFeed(f.ref);
        entries.forEach((e) => items.push({ ...e, kind: f.kind, feedLabel: f.label || e.source }));
      } else {
        skipped.push(`${f.label || f.kind} (${f.kind} ยังไม่รองรับบน Vercel)`);
      }
    }
    if (items.length === 0) return NextResponse.json({ ok: true, user: upn, count: 0, stories: [], skipped });

    items.sort((a, b) => (b.published || "").localeCompare(a.published || ""));
    const pool = items.slice(0, 25);

    // 3) stage 1 — pick 3 highlights + up to 2 from the newest-followed feed
    const listing = pool
      .map((it, i) => `${i}. [${it.feedLabel}]${it.feedLabel === newestLabel ? " [ใหม่]" : ""} ${it.title}`)
      .join("\n");
    let picks: number[] = [];
    try {
      const raw = await chat(
        'เลือกข่าวเด่นที่สุดจากรายการ (มี index) ตอบ JSON เท่านั้น {"highlights":[index 3 อัน],"new":[index จากแหล่ง [ใหม่] ไม่เกิน 2]}',
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
    if (picks.length === 0) picks = pool.slice(0, 3).map((_, i) => i);
    picks = Array.from(new Set(picks)).slice(0, 5);

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

    // 5) build stories + tracked short links
    const stories: Story[] = [];
    for (let i = 0; i < withText.length; i++) {
      const it = withText[i];
      const s = summaries[String(i)] || {};
      const shortLink = granted.has("read_tracking")
        ? await makeShortLink(upn, it.link, it.feedLabel, it.title)
        : it.link;
      stories.push({
        id: createHash("sha1").update(it.link).digest("hex").slice(0, 8),
        title: it.title,
        source: it.feedLabel,
        kind: it.kind as Story["kind"],
        whatHappened: s.whatHappened || it.summary.slice(0, 200),
        cause: s.cause || "",
        progress: s.progress || "",
        conclusion: s.conclusion || "",
        shortLink,
        rawLink: it.link,
        publishedAt: it.published || new Date().toISOString(),
      });
    }

    return NextResponse.json({ ok: true, user: upn, count: stories.length, stories, skipped });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
