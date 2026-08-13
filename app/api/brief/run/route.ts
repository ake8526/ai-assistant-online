import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { buildMorningAgenda, runForUser, type MorningAgenda } from "@/lib/brief";
import { buildDigest, formatStoriesText, rememberDeliveredStories, type DigestResult } from "@/lib/digest";
import { resolveLinkedUpn, sendLine } from "@/lib/line";
import {
  clearBriefPrewarm,
  clearNewsPrewarm,
  loadBriefPrewarm,
  loadNewsPrewarm,
} from "@/lib/morningCache";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { claimSend, clearInflight, dueNowForUsers, isDueNow, markSent } from "@/lib/notify";
import { runWithTrace, trace } from "@/lib/trace";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

/** Today's agenda — from the prewarm pass if it is there (the push must not wait
 *  on Graph at the delivery minute), otherwise built live. */
async function loadAgenda(upn: string): Promise<{ agenda: MorningAgenda; count: number }> {
  const cached = await loadBriefPrewarm(upn);
  if (cached) {
    trace("fetch", `ตารางเช้า (เตรียมไว้) · ${cached.eventCount} นัด`);
    return { agenda: cached.agenda, count: cached.eventCount };
  }
  trace("fetch", "ดึงตาราง Outlook", "start");
  const { result } = await withDelegatedGraph(upn, () => buildMorningAgenda(upn));
  trace("fetch", `ตารางเช้า · ${result.events.length} นัด`);
  return { agenda: result, count: result.events.length };
}

type OnlyKind = "brief" | "news" | "both";

function parseOnly(req: Request): OnlyKind {
  const v = (new URL(req.url).searchParams.get("only") || "both").toLowerCase();
  if (v === "brief" || v === "news") return v;
  return "both";
}

async function pushBrief(upn: string, force: boolean): Promise<string> {
  return runWithTrace({ upn, channel: "cron" }, async () => {
    if (!force && !(await isDueNow(upn, "brief"))) return "skip (not due)";
    trace("receive", "cron · สรุปตารางเช้า");

    let agenda: MorningAgenda;
    let count = 0;
    try {
      const built = await loadAgenda(upn);
      agenda = built.agenda;
      count = built.count;
    } catch (e) {
      const msg =
        "🌅 สรุปตารางเช้า\n\nดึงตารางจาก Outlook ไม่สำเร็จตอนนี้ครับ\n" +
        `เหตุผล: ${String(e).slice(0, 120)}\n\nพิมพ์ «สรุปตารางเช้า» เพื่อลองใหม่`;
      try {
        if (force || (await claimSend(upn, "brief"))) {
          await sendLine(upn, "", msg);
          await markSent(upn, "brief");
          trace("reply", "แจ้ง error กราฟ", "error");
          return "delivered graph-error notice";
        }
        return "skip (inflight or sent)";
      } catch {
        return `ERROR: ${String(e).slice(0, 150)}`;
      }
    }

    if (!force && !(await claimSend(upn, "brief"))) return "skip (inflight or sent)";
    try {
      trace("compose", "สรุปตารางเช้า");
      await runForUser(upn, agenda);
      await markSent(upn, "brief");
      await clearBriefPrewarm(upn);
      trace("reply", `ส่งสรุปเช้า (${count} นัด)`);
      return `delivered agenda (${count})`;
    } catch (e) {
      try {
        await sendLine(upn, "🌅 สรุปตารางเช้า", agenda.text);
        await markSent(upn, "brief");
        await clearBriefPrewarm(upn);
        trace("reply", "ส่งสรุปเช้า (text-fallback)");
        return "delivered text-fallback";
      } catch {
        await clearInflight(upn, "brief");
        return `ERROR: ${String(e).slice(0, 150)}`;
      }
    }
  });
}

async function sendBuiltNews(upn: string, force: boolean, d: DigestResult): Promise<string> {
  if (!d.stories?.length) {
    if (force || (await claimSend(upn, "news"))) {
      await markSent(upn, "news");
      await clearNewsPrewarm(upn);
      return d.note || "no stories";
    }
    return "skip (inflight or sent)";
  }
  if (!force && !(await claimSend(upn, "news"))) return "skip (inflight or sent)";
  try {
    await sendLine(upn, "", formatStoriesText(d.stories));
    await rememberDeliveredStories(upn, d.stories);
    await markSent(upn, "news");
    await clearNewsPrewarm(upn);
    return `delivered ${d.stories.length} stories`;
  } catch (e) {
    await clearInflight(upn, "news");
    return `ERROR: ${String(e).slice(0, 150)}`;
  }
}

async function pushNews(upn: string, force: boolean): Promise<string> {
  return runWithTrace({ upn, channel: "cron" }, async () => {
    if (!force && !(await isDueNow(upn, "news"))) return "skip (not due)";
    try {
      trace("receive", "cron · ส่งข่าวเช้า");
      // Prepared at 06:5x by /api/morning/prewarm → this is a pure push (<1s).
      // Nothing cached (prewarm missed) → build now: late beats missing.
      const ready = await loadNewsPrewarm(upn);
      if (ready) trace("fetch", `📰 ใช้ข่าวที่เตรียมไว้ · ${ready.stories.length} เรื่อง`);
      const d = ready || (await buildDigest(upn, { fast: true }));
      const status = await sendBuiltNews(upn, force, d);
      if (status.startsWith("delivered")) trace("reply", status);
      return status;
    } catch (e) {
      return `ERROR: ${String(e).slice(0, 150)}`;
    }
  });
}

/**
 * The Worker calls only=both every minute (cloudflare/src/worker.js) and each
 * kind goes out on its own minute: news first, then the agenda, which
 * `isDueFromState` holds back until news has actually gone out — so the agenda
 * always lands after it, with its quick-reply buttons on the newest message.
 * only=news / only=brief stay available for manual sends.
 */
async function deliverMorningForUser(
  upn: string,
  force: boolean,
  only: OnlyKind
): Promise<{ brief: string; news: string }> {
  if (only === "brief") {
    return { brief: await pushBrief(upn, force), news: "skip (only=brief)" };
  }
  if (only === "news") {
    return { brief: "skip (only=news)", news: await pushNews(upn, force) };
  }
  const news = await pushNews(upn, force);
  return { brief: await pushBrief(upn, force), news };
}

export async function POST(req: Request) {
  return run(req);
}

export async function GET(req: Request) {
  return run(req);
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (checkCronSecret(req)) {
      const url = new URL(req.url);
      const force = url.searchParams.get("force") === "1";
      const only = parseOnly(req);
      const onlyUpnQuery = (url.searchParams.get("upn") || "").trim();
      let users: string[];
      if (onlyUpnQuery) {
        const resolved = await resolveLinkedUpn(onlyUpnQuery);
        if (!resolved) {
          return NextResponse.json({ ok: false, error: `upn not linked: ${onlyUpnQuery}` }, { status: 404 });
        }
        users = [resolved];
      } else {
        users = await linkedUsers();
      }
      // One query decides who is due. This runs every minute all morning and
      // almost always finds nobody — checking per user per kind cost 4-6s, which
      // the "arrive at 07:00" target cannot spare.
      const due = force ? null : await dueNowForUsers(users);
      const results: Record<string, { brief: string; news: string }> = {};
      for (const upn of users) {
        const d = due?.[upn];
        if (d && !d.news && !d.brief) {
          results[upn] = { brief: "skip (not due)", news: "skip (not due)" };
          continue;
        }
        try {
          results[upn] = await deliverMorningForUser(upn, force, only);
        } catch (e) {
          results[upn] = {
            brief: `ERROR: ${String(e).slice(0, 150)}`,
            news: `ERROR: ${String(e).slice(0, 150)}`,
          };
        }
      }
      return NextResponse.json({ ok: true, only, results });
    }
    const upn = await requireUser(req);
    const { result: agenda } = await withDelegatedGraph(upn, () => buildMorningAgenda(upn));
    return NextResponse.json({ ok: true, brief: agenda.text, meetings: agenda.events.length });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
