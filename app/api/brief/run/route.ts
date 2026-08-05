import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { buildMorningAgenda, runForUser } from "@/lib/brief";
import { buildDigest, formatStoriesText, rememberDeliveredStories, type DigestResult } from "@/lib/digest";
import { sendLine } from "@/lib/line";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { claimSend, clearInflight, isDueNow, markSent } from "@/lib/notify";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

type OnlyKind = "brief" | "news" | "both";

function parseOnly(req: Request): OnlyKind {
  const v = (new URL(req.url).searchParams.get("only") || "both").toLowerCase();
  if (v === "brief" || v === "news") return v;
  return "both";
}

async function pushBrief(upn: string, force: boolean): Promise<string> {
  if (!force && !(await isDueNow(upn, "brief"))) return "skip (not due)";

  let agenda;
  try {
    const wrapped = await withDelegatedGraph(upn, () => buildMorningAgenda(upn));
    agenda = wrapped.result;
  } catch (e) {
    const msg =
      "🌅 สรุปตารางเช้า\n\nดึงตารางจาก Outlook ไม่สำเร็จตอนนี้ครับ\n" +
      `เหตุผล: ${String(e).slice(0, 120)}\n\nพิมพ์ «สรุปตารางเช้า» เพื่อลองใหม่`;
    try {
      if (force || (await claimSend(upn, "brief"))) {
        await sendLine(upn, "", msg);
        await markSent(upn, "brief");
        return "delivered graph-error notice";
      }
      return "skip (inflight or sent)";
    } catch {
      return `ERROR: ${String(e).slice(0, 150)}`;
    }
  }

  if (!force && !(await claimSend(upn, "brief"))) return "skip (inflight or sent)";
  try {
    await runForUser(upn, agenda);
    await markSent(upn, "brief");
    return `delivered agenda (${agenda.events.length})`;
  } catch (e) {
    try {
      await sendLine(upn, "🌅 สรุปตารางเช้า", agenda.text);
      await markSent(upn, "brief");
      return "delivered text-fallback";
    } catch {
      await clearInflight(upn, "brief");
      return `ERROR: ${String(e).slice(0, 150)}`;
    }
  }
}

async function sendBuiltNews(upn: string, force: boolean, d: DigestResult): Promise<string> {
  if (!d.stories?.length) {
    if (force || (await claimSend(upn, "news"))) {
      await markSent(upn, "news");
      return d.note || "no stories";
    }
    return "skip (inflight or sent)";
  }
  if (!force && !(await claimSend(upn, "news"))) return "skip (inflight or sent)";
  try {
    await sendLine(upn, "", formatStoriesText(d.stories));
    await rememberDeliveredStories(upn, d.stories);
    await markSent(upn, "news");
    return `delivered ${d.stories.length} stories`;
  } catch (e) {
    await clearInflight(upn, "news");
    return `ERROR: ${String(e).slice(0, 150)}`;
  }
}

async function pushNews(upn: string, force: boolean): Promise<string> {
  if (!force && !(await isDueNow(upn, "news"))) return "skip (not due)";
  try {
    const d = await buildDigest(upn);
    return await sendBuiltNews(upn, force, d);
  } catch (e) {
    return `ERROR: ${String(e).slice(0, 150)}`;
  }
}

/**
 * When only=both: push news first, then brief last so LINE quick-reply
 * numbers stay on the newest message. Cron still calls only=news / only=brief
 * as separate steps so a slow digest cannot starve the agenda.
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

  // both: start agenda fetch while news sends; push brief AFTER news (buttons last)
  const briefDue = force || (await isDueNow(upn, "brief"));
  const agendaP = briefDue
    ? withDelegatedGraph(upn, () => buildMorningAgenda(upn))
        .then(({ result }) => ({ ok: true as const, agenda: result }))
        .catch((e) => ({ ok: false as const, err: String(e).slice(0, 150) }))
    : null;

  const news = await pushNews(upn, force);

  let brief = "skip (not due)";
  if (!briefDue) {
    brief = "skip (not due)";
  } else if (!agendaP) {
    brief = "skip (not due)";
  } else {
    const built = await agendaP;
    if (!built.ok) {
      // Fall through to pushBrief (sends Graph-error notice or retries)
      brief = await pushBrief(upn, force);
    } else if (!force && !(await claimSend(upn, "brief"))) {
      brief = "skip (inflight or sent)";
    } else {
      try {
        await runForUser(upn, built.agenda);
        await markSent(upn, "brief");
        brief = `delivered agenda (${built.agenda.events.length})`;
      } catch (e) {
        try {
          await sendLine(upn, "🌅 สรุปตารางเช้า", built.agenda.text);
          await markSent(upn, "brief");
          brief = "delivered text-fallback";
        } catch {
          await clearInflight(upn, "brief");
          brief = `ERROR: ${String(e).slice(0, 150)}`;
        }
      }
    }
  }

  return { brief, news };
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
      const onlyUpn = (url.searchParams.get("upn") || "").toLowerCase().trim();
      const users = onlyUpn
        ? (await linkedUsers()).filter((u) => u.toLowerCase() === onlyUpn)
        : await linkedUsers();
      if (onlyUpn && !users.length) {
        return NextResponse.json({ ok: false, error: `upn not linked: ${onlyUpn}` }, { status: 404 });
      }
      const results: Record<string, { brief: string; news: string }> = {};
      for (const upn of users) {
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
