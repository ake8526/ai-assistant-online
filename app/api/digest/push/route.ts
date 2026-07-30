import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { sendLine } from "@/lib/line";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import type { Story } from "../route";

export const maxDuration = 300;

// GET/POST ?key=CRON_SECRET — build the following-digest for every linked user
// and push it into LINE (the scheduled 08:00 news digest).

function formatStories(stories: Story[]): string {
  const lines = ["📰 สรุปข่าวที่คุณติดตามวันนี้", ""];
  stories.forEach((s, i) => {
    lines.push(`${i + 1}) ${s.title} — ${s.source}`);
    if (s.whatHappened) lines.push(`   • เกิดอะไรขึ้น: ${s.whatHappened}`);
    if (s.cause) lines.push(`   • สาเหตุ: ${s.cause}`);
    if (s.progress) lines.push(`   • เป็นยังไงต่อ: ${s.progress}`);
    if (s.conclusion) lines.push(`   • สรุป: ${s.conclusion}`);
    if (s.rawLink) lines.push(`   🔗 ${s.rawLink}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const base = process.env.NEXT_PUBLIC_APP_BASE_URL || new URL(req.url).origin;
    const { data } = await admin.from("line_links").select("upn");
    const users = (data || []).map((r) => r.upn);

    const results: Record<string, string> = {};
    for (const upn of users) {
      try {
        const r = await fetch(`${base}/api/digest?upn=${encodeURIComponent(upn)}`);
        const d = await r.json();
        if (!d.ok || !d.stories?.length) {
          results[upn] = d.note || "no stories";
          continue;
        }
        await sendLine(upn, "", formatStories(d.stories));
        results[upn] = `delivered ${d.stories.length} stories`;
      } catch (e) {
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
