import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { buildForToday, runForUser } from "@/lib/brief";
import { buildDigest, formatStoriesText } from "@/lib/digest";
import { sendLine } from "@/lib/line";
import { isDueNow, markSent } from "@/lib/notify";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

/** Push the news digest for one user if their schedule is due (or force). */
async function pushNewsIfDue(upn: string, force: boolean): Promise<string> {
  if (!force && !(await isDueNow(upn, "news"))) return "skip (not due)";
  const { stories, note } = await buildDigest(upn);
  if (!stories?.length) return note || "no stories";
  await sendLine(upn, "", formatStoriesText(stories));
  await markSent(upn, "news");
  return `delivered ${stories.length} stories`;
}

// POST/GET — build + deliver the morning brief.
// Cron mode (?key=CRON_SECRET): run for every linked user, push to LINE.
//   Pushes news digest first (when due), then morning brief — so chat order is
//   ข่าว → ตาราง.
// User mode (Bearer token): build the caller's brief and return the text.
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
      // `force=1` bypasses the per-user schedule (manual/test run for everyone).
      const force = new URL(req.url).searchParams.get("force") === "1";
      const results: Record<string, { brief: string; news: string }> = {};
      for (const upn of await linkedUsers()) {
        const row = { brief: "skip", news: "skip" };
        // News first, then morning brief — so LINE shows ข่าว then ตาราง
        try {
          row.news = await pushNewsIfDue(upn, force);
        } catch (e) {
          row.news = `ERROR: ${String(e).slice(0, 150)}`;
        }
        try {
          if (!force && !(await isDueNow(upn, "brief"))) {
            row.brief = "skip (not due)";
          } else {
            await runForUser(upn);
            await markSent(upn, "brief");
            row.brief = "delivered";
          }
        } catch (e) {
          row.brief = `ERROR: ${String(e).slice(0, 150)}`;
        }
        results[upn] = row;
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
