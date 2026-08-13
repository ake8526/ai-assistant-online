// Build the morning payloads BEFORE each user's delivery minute.
//
// The digest takes ~100s to build, so the delivery time can only be hit if the
// content already exists when the clock strikes. The Cloudflare Worker calls
// ?stage=auto every minute through the morning; this route looks at each user's
// own `news_time` / `brief_time` and prepares whatever is coming up — news ~4–12
// min ahead (three-plus attempts, each a no-op once cached) and the agenda 1–3
// min ahead, where a fresher calendar is worth the rebuild.
//
// Then /api/brief/run just pushes what is cached. Nothing here sends to LINE.
//
// Heavy work runs after the response (waitUntil/after, maxDuration 300) so the
// caller never holds a 100s connection open — same pattern as digest/push.
// Manual runs can pass ?wait=1 to get the results inline. See
// docs/morning-delivery-plan.md.
import { NextResponse, after } from "next/server";
import { waitUntil } from "@vercel/functions";
import { checkCronSecret } from "@/lib/auth";
import { buildMorningAgenda } from "@/lib/brief";
import { buildDigest } from "@/lib/digest";
import { resolveLinkedUpn } from "@/lib/line";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { hasFreshNewsPrewarm, saveBriefPrewarm, saveNewsPrewarm } from "@/lib/morningCache";
import {
  alreadySentToday,
  bkkNowParts,
  minutesUntil,
  notifyConfigFromSettings,
  NOTIFY_SETTING_KEYS,
  type NotifyKind,
} from "@/lib/notify";
import { getSettingsFor } from "@/lib/store";
import { runWithTrace, trace } from "@/lib/trace";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

type Stage = "news" | "brief" | "both" | "auto";

/** How far ahead of the delivery minute each payload is prepared. */
const NEWS_LEAD_MIN = { from: 4, to: 12 }; // build takes ~100s + retries
const BRIEF_LEAD_MIN = { from: 1, to: 3 }; // ~5s, so as late (= as fresh) as possible

function parseStage(req: Request): Stage {
  const v = (new URL(req.url).searchParams.get("stage") || "both").toLowerCase();
  return v === "news" || v === "brief" || v === "auto" ? v : "both";
}

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

/** Which payloads to prepare for each user right now. */
async function planPrewarm(users: string[], stage: Stage): Promise<Record<string, NotifyKind[]>> {
  const plan: Record<string, NotifyKind[]> = {};
  if (stage !== "auto") {
    const kinds: NotifyKind[] = stage === "both" ? ["news", "brief"] : [stage];
    for (const upn of users) plan[upn] = kinds;
    return plan;
  }
  // auto: follow each user's configured time, whatever it is
  const rows = await getSettingsFor(users, NOTIFY_SETTING_KEYS);
  const at = bkkNowParts();
  for (const upn of users) {
    const cfg = notifyConfigFromSettings(rows[upn] || {});
    const kinds: NotifyKind[] = [];
    for (const kind of ["news", "brief"] as NotifyKind[]) {
      const k = cfg[kind];
      if (!k.enabled || !k.days.includes(at.day)) continue;
      const lead = kind === "news" ? NEWS_LEAD_MIN : BRIEF_LEAD_MIN;
      const away = minutesUntil(k.time);
      if (away >= lead.from && away <= lead.to) kinds.push(kind);
    }
    if (kinds.length) plan[upn] = kinds;
  }
  return plan;
}

/** ?explain=1 — what the schedule looks like right now, without doing anything.
 *  Use it to confirm each user's resolved delivery times (incl. the agenda's
 *  derived +1 minute) and how far away they are. */
async function explainSchedule(users: string[]) {
  const rows = await getSettingsFor(users, NOTIFY_SETTING_KEYS);
  const at = bkkNowParts();
  const out: Record<string, unknown> = {};
  for (const upn of users) {
    const cfg = notifyConfigFromSettings(rows[upn] || {});
    out[upn] = {
      news: { ...cfg.news, today: cfg.news.days.includes(at.day), minutesAway: minutesUntil(cfg.news.time) },
      brief: { ...cfg.brief, today: cfg.brief.days.includes(at.day), minutesAway: minutesUntil(cfg.brief.time) },
      sent: {
        news: await alreadySentToday(upn, "news"),
        brief: await alreadySentToday(upn, "brief"),
      },
      newsPrepared: await hasFreshNewsPrewarm(upn),
    };
  }
  return { now: at, leads: { news: NEWS_LEAD_MIN, brief: BRIEF_LEAD_MIN }, users: out };
}

async function prewarmNews(upn: string, force: boolean): Promise<string> {
  if (!force && (await alreadySentToday(upn, "news"))) return "skip (already sent today)";
  if (!force && (await hasFreshNewsPrewarm(upn))) return "skip (already prepared)";
  return runWithTrace({ upn, channel: "cron" }, async () => {
    trace("receive", "cron · เตรียมข่าวล่วงหน้า");
    const d = await buildDigest(upn, { fast: true });
    await saveNewsPrewarm(upn, d);
    trace("compose", `📰 เตรียมข่าวพร้อมส่ง · ${d.stories?.length || 0} เรื่อง`);
    return `prepared ${d.stories?.length || 0} stories`;
  });
}

async function prewarmBrief(upn: string, force: boolean): Promise<string> {
  if (!force && (await alreadySentToday(upn, "brief"))) return "skip (already sent today)";
  // Always rebuild — the agenda costs ~5s and a later pass is a fresher calendar.
  return runWithTrace({ upn, channel: "cron" }, async () => {
    trace("receive", "cron · เตรียมตารางเช้าล่วงหน้า");
    const { result: agenda } = await withDelegatedGraph(upn, () => buildMorningAgenda(upn));
    await saveBriefPrewarm(upn, agenda);
    trace("compose", `เตรียมตารางเช้าพร้อมส่ง · ${agenda.events.length} นัด`);
    return `prepared agenda (${agenda.events.length})`;
  });
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const stage = parseStage(req);
    const force = url.searchParams.get("force") === "1";
    const wait = url.searchParams.get("wait") === "1"; // manual runs: hold for results
    const upnQuery = (url.searchParams.get("upn") || "").trim();

    let users: string[];
    if (upnQuery) {
      const resolved = await resolveLinkedUpn(upnQuery);
      if (!resolved) {
        return NextResponse.json({ ok: false, error: `upn not linked: ${upnQuery}` }, { status: 404 });
      }
      users = [resolved];
    } else {
      users = await linkedUsers();
    }

    if (url.searchParams.get("explain") === "1") {
      return NextResponse.json({ ok: true, ...(await explainSchedule(users)) });
    }

    const plan = await planPrewarm(users, stage);
    const results: Record<string, Record<string, string>> = {};
    if (!Object.keys(plan).length) {
      return NextResponse.json({ ok: true, stage, results, note: "nothing due to prepare" });
    }

    // Sequential: the digest is LLM-bound and parallel users would trip provider
    // rate limits (the same reason the delivery loop is serial).
    const job = (async () => {
      for (const [upn, kinds] of Object.entries(plan)) {
        results[upn] = {};
        for (const kind of kinds) {
          try {
            results[upn][kind] =
              kind === "news" ? await prewarmNews(upn, force) : await prewarmBrief(upn, force);
          } catch (e) {
            results[upn][kind] = `ERROR: ${String(e).slice(0, 150)}`;
          }
        }
      }
    })();

    if (wait) {
      await job;
      return NextResponse.json({ ok: true, stage, results });
    }

    try {
      waitUntil(job);
    } catch {
      /* non-Vercel runtime */
    }
    after(async () => {
      try {
        await job;
      } catch {
        /* recorded per user */
      }
    });
    // Brief wait so the build has actually started before the isolate freezes.
    await Promise.race([job, new Promise((r) => setTimeout(r, 5_000))]);
    return NextResponse.json({ ok: true, stage, mode: "background", results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return run(req);
}

export async function POST(req: Request) {
  return run(req);
}
