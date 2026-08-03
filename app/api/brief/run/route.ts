import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { buildMorningAgenda, runForUser } from "@/lib/brief";
import { buildDigest, formatStoriesText, rememberDeliveredStories } from "@/lib/digest";
import { sendLine } from "@/lib/line";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import { isDueNow, markSent } from "@/lib/notify";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

/**
 * Build news + agenda in parallel, push news first then agenda (with prep buttons).
 */
async function deliverMorningForUser(
  upn: string,
  force: boolean
): Promise<{ brief: string; news: string }> {
  const newsDue = force || (await isDueNow(upn, "news"));
  const briefDue = force || (await isDueNow(upn, "brief"));
  const row = {
    brief: briefDue ? "pending" : "skip (not due)",
    news: newsDue ? "pending" : "skip (not due)",
  };
  if (!newsDue && !briefDue) return row;

  const [newsResult, agendaResult] = await Promise.all([
    newsDue
      ? buildDigest(upn)
          .then((d) => ({ ok: true as const, d }))
          .catch((e) => ({ ok: false as const, err: String(e).slice(0, 150) }))
      : Promise.resolve(null),
    briefDue
      ? withDelegatedGraph(upn, () => buildMorningAgenda(upn))
          .then(({ result }) => ({ ok: true as const, agenda: result }))
          .catch((e) => ({ ok: false as const, err: String(e).slice(0, 150) }))
      : Promise.resolve(null),
  ]);

  if (newsResult) {
    if (!newsResult.ok) {
      row.news = `ERROR: ${newsResult.err}`;
    } else if (!newsResult.d.stories?.length) {
      row.news = newsResult.d.note || "no stories";
      await markSent(upn, "news");
    } else {
      await sendLine(upn, "", formatStoriesText(newsResult.d.stories));
      await rememberDeliveredStories(upn, newsResult.d.stories);
      await markSent(upn, "news");
      row.news = `delivered ${newsResult.d.stories.length} stories`;
    }
  }

  if (agendaResult) {
    if (!agendaResult.ok) {
      row.brief = `ERROR: ${agendaResult.err}`;
    } else {
      try {
        await runForUser(upn, agendaResult.agenda);
        await markSent(upn, "brief");
        row.brief = `delivered agenda (${agendaResult.agenda.events.length})`;
      } catch (e) {
        try {
          await sendLine(upn, "🌅 สรุปตารางเช้า", agendaResult.agenda.text);
          await markSent(upn, "brief");
          row.brief = `delivered text-fallback`;
        } catch {
          row.brief = `ERROR: ${String(e).slice(0, 150)}`;
        }
      }
    }
  }

  return row;
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
      const results: Record<string, { brief: string; news: string }> = {};
      for (const upn of await linkedUsers()) {
        try {
          results[upn] = await deliverMorningForUser(upn, force);
        } catch (e) {
          results[upn] = {
            brief: `ERROR: ${String(e).slice(0, 150)}`,
            news: `ERROR: ${String(e).slice(0, 150)}`,
          };
        }
      }
      return NextResponse.json({ ok: true, results });
    }
    const upn = await requireUser(req);
    const { result: agenda } = await withDelegatedGraph(upn, () => buildMorningAgenda(upn));
    return NextResponse.json({ ok: true, brief: agenda.text, meetings: agenda.events.length });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
