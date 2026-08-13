// Build tomorrow-morning's payloads BEFORE the delivery minute.
//
// The digest takes ~100s to build, so 07:00 can only be hit if the content
// already exists when the clock strikes. The Cloudflare Worker calls:
//   06:50 / 06:53 / 06:56  ?stage=news   (retries: later calls skip if cached)
//   06:59                  ?stage=brief  (also warms the function for 07:00)
// Then /api/brief/run?only=news at 07:00 and ?only=brief at 07:01 just push.
//
// Heavy work runs after the response (waitUntil/after, maxDuration 300) so the
// caller never has to hold a 100s connection open — same pattern as digest/push.
import { NextResponse, after } from "next/server";
import { waitUntil } from "@vercel/functions";
import { checkCronSecret } from "@/lib/auth";
import { buildMorningAgenda } from "@/lib/brief";
import { buildDigest } from "@/lib/digest";
import { resolveLinkedUpn } from "@/lib/line";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { hasFreshNewsPrewarm, saveBriefPrewarm, saveNewsPrewarm } from "@/lib/morningCache";
import { alreadySentToday } from "@/lib/notify";
import { runWithTrace, trace } from "@/lib/trace";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

type Stage = "news" | "brief" | "both";

function parseStage(req: Request): Stage {
  const v = (new URL(req.url).searchParams.get("stage") || "both").toLowerCase();
  return v === "news" || v === "brief" ? v : "both";
}

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
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

async function prewarmUser(upn: string, stage: Stage, force: boolean): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (stage === "news" || stage === "both") {
    try {
      out.news = await prewarmNews(upn, force);
    } catch (e) {
      out.news = `ERROR: ${String(e).slice(0, 150)}`;
    }
  }
  if (stage === "brief" || stage === "both") {
    try {
      out.brief = await prewarmBrief(upn, force);
    } catch (e) {
      out.brief = `ERROR: ${String(e).slice(0, 150)}`;
    }
  }
  return out;
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const stage = parseStage(req);
    const force = url.searchParams.get("force") === "1";
    const wait = url.searchParams.get("wait") === "1"; // manual testing: hold for results
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

    const results: Record<string, Record<string, string>> = {};
    // Sequential across users: the digest is LLM-bound and parallel users would
    // trip provider rate limits (the same reason the delivery loop is serial).
    const job = (async () => {
      for (const upn of users) {
        results[upn] = await prewarmUser(upn, stage, force);
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
        /* logged per user */
      }
    });
    // Brief wait so the build has actually started before the isolate freezes.
    await Promise.race([job, new Promise((r) => setTimeout(r, 5_000))]);
    return NextResponse.json({ ok: true, stage, mode: "background", users: users.length, results });
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
