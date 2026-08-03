import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { buildForToday } from "@/lib/brief";
import { buildDigest, formatStoriesText } from "@/lib/digest";
import { sendLine } from "@/lib/line";
import { isDueNow, markSent } from "@/lib/notify";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

/**
 * Build news + brief in parallel (so we don't stack delays), then push
 * news first and brief right after — as close as possible to the scheduled time.
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

  // Parallel build — wall clock ≈ max(news, brief), not sum
  const [newsResult, briefResult] = await Promise.all([
    newsDue
      ? buildDigest(upn)
          .then((d) => ({ ok: true as const, d }))
          .catch((e) => ({ ok: false as const, err: String(e).slice(0, 150) }))
      : Promise.resolve(null),
    briefDue
      ? buildForToday(upn)
          .then((text) => ({ ok: true as const, text }))
          .catch((e) => ({ ok: false as const, err: String(e).slice(0, 150) }))
      : Promise.resolve(null),
  ]);

  // Send news first, then brief — back-to-back once both are ready
  if (newsResult) {
    if (!newsResult.ok) {
      row.news = `ERROR: ${newsResult.err}`;
    } else if (!newsResult.d.stories?.length) {
      row.news = newsResult.d.note || "no stories";
      // Still mark sent so we don't keep retrying empty digests all day
      await markSent(upn, "news");
    } else {
      await sendLine(upn, "", formatStoriesText(newsResult.d.stories));
      await markSent(upn, "news");
      row.news = `delivered ${newsResult.d.stories.length} stories`;
    }
  }

  if (briefResult) {
    if (!briefResult.ok) {
      row.brief = `ERROR: ${briefResult.err}`;
    } else {
      await sendLine(upn, "🌅 Morning Brief วันนี้", briefResult.text);
      await markSent(upn, "brief");
      row.brief = "delivered";
    }
  }

  return row;
}

// POST/GET — build + deliver morning news + brief.
// Cron mode (?key=CRON_SECRET): for every linked user due now — parallel build,
// then push ข่าว → ตาราง back-to-back near the user's set time.
// User mode (Bearer token): build the caller's brief text only.
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
    const text = await buildForToday(upn);
    return NextResponse.json({ ok: true, brief: text });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
