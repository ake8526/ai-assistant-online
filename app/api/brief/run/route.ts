import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { buildMorningAgenda, runForUser, type MorningAgenda } from "@/lib/brief";
import { buildDigest, formatStoriesText, rememberDeliveredStories, type DigestResult } from "@/lib/digest";
import { pushQuotaGone, resolveLinkedUpn, sendLine } from "@/lib/line";
import { jobSkipReason } from "@/lib/jobHealth";
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
      } catch (e2) {
        trace("error", `แจ้ง error ไม่สำเร็จ · ${String(e2).slice(0, 120)}`, "error");
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
        await sendLine(upn, "🌅 สรุปตารางเช้า", agenda.text, true);
        await markSent(upn, "brief");
        await clearBriefPrewarm(upn);
        trace("reply", "ส่งสรุปเช้า (text-fallback)");
        return "delivered text-fallback";
      } catch (e2) {
        // Both the rich push and the plain-text fallback failed — without this
        // the whole morning shows up in /monitor/log as "ไม่จบงาน" with no
        // reason, and the tick just retries forever (e.g. LINE push quota 429).
        trace("error", `ส่ง LINE ไม่สำเร็จ · ${String(e2).slice(0, 120)}`, "error");
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
    await sendLine(upn, "", formatStoriesText(d.stories), true);
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
      else if (status.startsWith("ERROR")) trace("error", `ส่งข่าวไม่สำเร็จ · ${status.slice(0, 120)}`, "error");
      // No stories today is a finished run with nothing to push, not a failure.
      else if (!d.stories?.length) trace("reply", "ไม่มีข่าวให้ส่ง", "skip");
      return status;
    } catch (e) {
      trace("error", `ข่าวเช้าล้ม · ${String(e).slice(0, 120)}`, "error");
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
  only: OnlyKind,
  /** Set when the job has been paused (by hand or by itself) — reported per user
   *  so the response still says why nobody was served. */
  paused: { brief: string | null; news: string | null } = { brief: null, news: null }
): Promise<{ brief: string; news: string }> {
  const doBrief = async () =>
    paused.brief ? `skip (${paused.brief})` : pushBrief(upn, force);
  const doNews = async () => (paused.news ? `skip (${paused.news})` : pushNews(upn, force));

  if (only === "brief") {
    return { brief: await doBrief(), news: "skip (only=brief)" };
  }
  if (only === "news") {
    return { brief: "skip (only=news)", news: await doNews() };
  }
  const news = await doNews();
  return { brief: await doBrief(), news };
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
      // One query decides who is due, before anything else is asked: outside the
      // delivery window (set time + NOTIFY_LATE_CUTOFF_MIN) there is nobody to
      // serve, so the tick must cost nothing and say nothing — it fires every
      // 5 minutes until 20:55.
      const due = force ? null : await dueNowForUsers(users);
      const anyDue = !due || users.some((u) => due[u]?.news || due[u]?.brief);
      if (!anyDue) {
        return NextResponse.json({ ok: true, only, skipped: "nobody due" });
      }

      // Someone IS due. Nothing can go out until the quota resets with the
      // month, so say it once and stop, instead of rebuilding every brief to
      // fail at the last step. force=1 (a manual send) still goes through.
      if (!force && (await pushQuotaGone())) {
        await runWithTrace({ channel: "cron" }, async () => {
          trace("receive", "cron · สรุปตารางเช้า");
          trace(
            "reply",
            "ข้ามรอบส่ง · โควตา push ของ LINE หมดเดือนนี้ (จะส่งได้อีกครั้งเมื่อโควตารีเซ็ต)",
            "skip"
          );
        });
        return NextResponse.json({ ok: true, only, skipped: "line-quota-exhausted" });
      }
      // Paused from /monitor/log, or paused by itself after half an hour of runs
      // that kept failing. Checked once for the whole tick, not per user.
      const paused = force
        ? { brief: null, news: null }
        : {
            brief: only === "news" ? null : await jobSkipReason("brief"),
            news: only === "brief" ? null : await jobSkipReason("news"),
          };
      const results: Record<string, { brief: string; news: string }> = {};
      for (const upn of users) {
        const d = due?.[upn];
        if (d && !d.news && !d.brief) {
          results[upn] = { brief: "skip (not due)", news: "skip (not due)" };
          continue;
        }
        try {
          results[upn] = await deliverMorningForUser(upn, force, only, paused);
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
