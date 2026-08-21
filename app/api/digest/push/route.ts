import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { resolveLinkedUpn } from "@/lib/line";
import { kickLineDigest } from "@/lib/digestKick";
import { isDueNow } from "@/lib/notify";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { after } from "next/server";
import { waitUntil } from "@vercel/functions";

export const maxDuration = 60;

// Cron entry: quickly enqueue per-user line-now jobs (maxDuration=300 each).
// Building digests inline here used to 504 when several users were due.

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const force = new URL(req.url).searchParams.get("force") === "1";
    const upnQuery = (new URL(req.url).searchParams.get("upn") || "").trim();
    let users: string[];
    if (upnQuery) {
      const resolved = await resolveLinkedUpn(upnQuery);
      if (!resolved) {
        return NextResponse.json({ ok: false, error: `upn not linked: ${upnQuery}` }, { status: 404 });
      }
      users = [resolved];
    } else {
      const { data } = await admin.from("line_links").select("upn");
      users = (data || []).map((r) => r.upn);
    }

    const results: Record<string, string> = {};
    const jobs: Promise<void>[] = [];

    for (const upn of users) {
      try {
        if (!force && !(await isDueNow(upn, "news"))) {
          results[upn] = "skip (not due)";
          continue;
        }
        // Fire line-now (own 300s isolate). kickLineDigest registers waitUntil.
        const p = kickLineDigest(upn)
          .then(() => {
            results[upn] = "kicked line-now";
          })
          .catch((e) => {
            results[upn] = `ERROR: ${String(e).slice(0, 120)}`;
          });
        jobs.push(p);
        results[upn] = "kicking…";
      } catch (e) {
        results[upn] = `ERROR: ${String(e).slice(0, 150)}`;
      }
    }

    const all = Promise.allSettled(jobs);
    try {
      waitUntil(all);
    } catch {
      /* non-Vercel */
    }
    after(async () => {
      try {
        await all;
      } catch {
        /* ignore */
      }
    });

    // Brief wait so setSetting + fetch start before freeze
    await Promise.race([all, new Promise((r) => setTimeout(r, 8_000))]);

    return NextResponse.json({ ok: true, mode: "enqueue", results });
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
