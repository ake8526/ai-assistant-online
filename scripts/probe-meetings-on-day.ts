/**
 * List ended online meetings around a date and probe transcript availability.
 * Usage: npx tsx scripts/probe-meetings-on-day.ts [upn] [YYYY-MM-DD]
 */
import fs from "fs";
import path from "path";
import {
  getOnlineMeetingId,
  getUserId,
  listTranscriptsProbe,
  getTranscriptContentProbe,
  type GraphEvent,
} from "../lib/graph";
import { getRecentOnlineEvents } from "../lib/meetings";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function resolveOwners(upn: string, event: GraphEvent): Promise<{ owner: string; ownerId: string; meetingId: string } | null> {
  const joinUrl = event.onlineMeeting?.joinUrl;
  if (!joinUrl) return null;
  const organizer = event.organizer?.emailAddress?.address;
  const owners = [...new Set([organizer, upn].filter(Boolean))] as string[];
  for (const owner of owners) {
    try {
      const ownerId = await getUserId(owner);
      if (!ownerId) continue;
      const meetingId = await getOnlineMeetingId(ownerId, joinUrl);
      if (!meetingId) continue;
      return { owner, ownerId, meetingId };
    } catch {
      /* next */
    }
  }
  return null;
}

async function main() {
  loadEnvLocal();
  const upn = (process.argv[2] || "weerasak.pi@ktisgroup.com").trim();
  const day = (process.argv[3] || "2026-08-05").trim(); // Asia/Bangkok calendar day

  console.log(`=== Meetings on ${day} for ${upn} ===\n`);

  // 14-day lookback covers Aug 5 from "today" Aug 6
  const events = await getRecentOnlineEvents(upn, 24 * 14);
  const onDay = events.filter((ev) => {
    const end = ev.end?.dateTime || "";
    // Graph wall times are local without Z typically: 2026-08-05T15:00:00.0000000
    return end.startsWith(day);
  });

  if (!onDay.length) {
    console.log("No ended online meetings found ending on that day.");
    console.log(`(total recent online ended: ${events.length})`);
    for (const ev of events.slice(-8)) {
      console.log(`  - ${ev.end?.dateTime} | ${ev.subject}`);
    }
    return;
  }

  console.log(`Found ${onDay.length} online meeting(s) ending on ${day}:\n`);

  for (const ev of onDay) {
    console.log(`• ${ev.subject || "(no subject)"}`);
    console.log(`  end: ${ev.end?.dateTime}`);
    console.log(`  organizer: ${ev.organizer?.emailAddress?.address || "?"}`);
    console.log(`  id: ${ev.id}`);

    const ctx = await resolveOwners(upn, ev);
    if (!ctx) {
      console.log(`  transcript: cannot resolve onlineMeeting\n`);
      continue;
    }
    console.log(`  owner: ${ctx.owner}`);

    const list = await listTranscriptsProbe(ctx.ownerId, ctx.meetingId);
    if (!list.ok) {
      console.log(`  transcript: FAIL/${list.status} ${(list.error || "").slice(0, 160)}\n`);
      continue;
    }
    if (!list.items.length) {
      console.log(`  transcript: EMPTY (0) — นัดนี้ไม่ได้เปิดถอดเสียงตอนประชุม\n`);
      continue;
    }
    const newest = [...list.items].reverse()[0];
    const content = await getTranscriptContentProbe(ctx.ownerId, ctx.meetingId, newest.id);
    if (content.ok) {
      console.log(`  transcript: OK — ${list.items.length} file(s), ${content.chars} chars`);
      console.log(`  → สามารถสรุปนัดนี้ได้ (event id ด้านบน)\n`);
    } else {
      console.log(`  transcript: LIST ${list.items.length} but content FAIL/${content.status} ${(content.error || "").slice(0, 160)}\n`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
