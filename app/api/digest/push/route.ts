import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { sendLine } from "@/lib/line";
import { claimSend, clearInflight, isDueNow, markSent } from "@/lib/notify";
import { runWithTrace } from "@/lib/trace";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { buildDigest, formatStoriesText, rememberDeliveredStories } from "@/lib/digest";

export const maxDuration = 300;

// GET/POST ?key=CRON_SECRET — build the following-digest and push it into LINE,
// but only for users whose news schedule is due right now (?force=1 = everyone).

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const force = new URL(req.url).searchParams.get("force") === "1";
    const { data } = await admin.from("line_links").select("upn");
    const users = (data || []).map((r) => r.upn);

    const results: Record<string, string> = {};
    for (const upn of users) {
      try {
        await runWithTrace({ upn, channel: "cron" }, async () => {
          if (!force && !(await isDueNow(upn, "news"))) {
            results[upn] = "skip (not due)";
            return;
          }
          const { stories, note } = await buildDigest(upn);
          if (!stories?.length) {
            if (force || (await claimSend(upn, "news"))) {
              await markSent(upn, "news");
              results[upn] = note || "no stories";
            } else {
              results[upn] = "skip (inflight or sent)";
            }
            return;
          }
          if (new URL(req.url).searchParams.get("seed_seen") === "1") {
            await rememberDeliveredStories(upn, stories);
            if (force || (await claimSend(upn, "news"))) await markSent(upn, "news");
            results[upn] = `seeded ${stories.length} seen (no push)`;
            return;
          }
          if (!force && !(await claimSend(upn, "news"))) {
            results[upn] = "skip (inflight or sent)";
            return;
          }
          await sendLine(upn, "", formatStoriesText(stories));
          await rememberDeliveredStories(upn, stories);
          await markSent(upn, "news");
          results[upn] = `delivered ${stories.length} stories`;
        });
      } catch (e) {
        await clearInflight(upn, "news").catch(() => {});
        results[upn] = `ERROR: ${String(e).slice(0, 150)}`;
      }
    }
    return NextResponse.json({ ok: true, results });
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
