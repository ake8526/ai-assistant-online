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
 * Brief always completes (and is pushed) before news is pushed.
 * When only=both, digest build starts in parallel with brief so news still
 * arrives ASAP after the agenda — without risking a news timeout eating brief.
 */
async function deliverMorningForUser(
  upn: string,
  force: boolean,
  only: OnlyKind
): Promise<{ brief: string; news: string }> {
  const wantBrief = only === "brief" || only === "both";
  const wantNews = only === "news" || only === "both";

  if (only === "brief") {
    return { brief: await pushBrief(upn, force), news: "skip (only=brief)" };
  }
  if (only === "news") {
    return { brief: "skip (only=news)", news: await pushNews(upn, force) };
  }

  // both: build digest while brief runs; send news only after brief push
  const newsDue = force || (await isDueNow(upn, "news"));
  const digestP = newsDue
    ? buildDigest(upn)
        .then((d) => ({ ok: true as const, d }))
        .catch((e) => ({ ok: false as const, err: String(e).slice(0, 150) }))
    : null;

  const brief = wantBrief ? await pushBrief(upn, force) : "skip (only=news)";

  let news = "skip (not due)";
  if (wantNews && digestP) {
    const built = await digestP;
    news = built.ok ? await sendBuiltNews(upn, force, built.d) : `ERROR: ${built.err}`;
  } else if (wantNews && !newsDue) {
    news = "skip (not due)";
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
      const force = new URL(req.url).searchParams.get("force") === "1";
      const only = parseOnly(req);
      const results: Record<string, { brief: string; news: string }> = {};
      for (const upn of await linkedUsers()) {
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
