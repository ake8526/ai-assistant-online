/**
 * Probe Teams meeting content sources for one finished online meeting:
 *  1) Transcript (VTT)
 *  2) Recording (list + content headers)
 *  3) Copilot AI Insights
 *
 * Usage:
 *   npx tsx scripts/probe-meeting-sources.ts [upn] [eventId]
 *
 * Defaults UPN to weerasak.pi@ktisgroup.com (or first line_links row if available).
 */
import fs from "fs";
import path from "path";
import {
  getEvent,
  getOnlineMeetingId,
  getUserId,
  listAiInsights,
  getAiInsight,
  listRecordings,
  listTranscriptsProbe,
  getTranscriptContentProbe,
  probeRecordingContent,
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

async function resolveUpn(arg?: string): Promise<string> {
  if (arg) return arg.trim();
  // Prefer known pilot from morning_brief config convention
  const fallback = "weerasak.pi@ktisgroup.com";
  try {
    const { admin, assertConfigured } = await import("../lib/supabaseServer");
    assertConfigured();
    const { data } = await admin.from("line_links").select("upn").limit(1);
    if (data?.[0]?.upn) return data[0].upn as string;
  } catch {
    /* ignore */
  }
  return fallback;
}

async function pickEvent(upn: string, eventId?: string): Promise<GraphEvent> {
  if (eventId) {
    const ev = await getEvent(upn, eventId);
    if (!ev) throw new Error(`event not found: ${eventId}`);
    return ev;
  }
  // Prefer lookback 14 days so we find meetings with transcripts
  const events = await getRecentOnlineEvents(upn, 24 * 14);
  if (!events.length) {
    throw new Error(`no ended online meetings in last 14 days for ${upn}`);
  }
  // Prefer ones with joinUrl
  const withJoin = events.filter((e) => e.onlineMeeting?.joinUrl);
  const pick = withJoin[withJoin.length - 1] || events[events.length - 1];
  return pick;
}

type OwnerCtx = { owner: string; ownerId: string; meetingId: string };

async function resolveMeeting(upn: string, event: GraphEvent): Promise<OwnerCtx> {
  const joinUrl = event.onlineMeeting?.joinUrl;
  if (!joinUrl) throw new Error("event has no onlineMeeting.joinUrl");

  const organizer = event.organizer?.emailAddress?.address;
  const owners = [...new Set([organizer, upn].filter(Boolean))] as string[];
  const errors: string[] = [];

  for (const owner of owners) {
    try {
      const ownerId = await getUserId(owner);
      if (!ownerId) {
        errors.push(`${owner}: no user id`);
        continue;
      }
      const meetingId = await getOnlineMeetingId(ownerId, joinUrl);
      if (!meetingId) {
        errors.push(`${owner}: onlineMeeting not found by joinUrl`);
        continue;
      }
      return { owner, ownerId, meetingId };
    } catch (e) {
      errors.push(`${owner}: ${String(e).slice(0, 120)}`);
    }
  }
  throw new Error(`could not resolve onlineMeeting:\n  ${errors.join("\n  ")}`);
}

function line(label: string, status: string, detail: string) {
  console.log(`  ${label.padEnd(14)} ${status.padEnd(8)} ${detail}`);
}

async function main() {
  loadEnvLocal();
  const upn = await resolveUpn(process.argv[2]);
  const eventId = process.argv[3];

  console.log("=== Teams meeting sources probe ===");
  console.log(`upn: ${upn}`);

  const event = await pickEvent(upn, eventId);
  console.log(`event: ${event.subject || "(no subject)"}`);
  console.log(`  id: ${event.id}`);
  console.log(`  end: ${event.end?.dateTime || "?"}`);
  console.log(`  organizer: ${event.organizer?.emailAddress?.address || "?"}`);
  console.log(`  joinUrl: ${(event.onlineMeeting?.joinUrl || "").slice(0, 80)}…`);

  const ctx = await resolveMeeting(upn, event);
  console.log(`resolved as owner=${ctx.owner} meetingId=${ctx.meetingId.slice(0, 24)}…`);
  console.log("");
  console.log("--- results ---");

  // 1) Transcript
  const trList = await listTranscriptsProbe(ctx.ownerId, ctx.meetingId);
  if (!trList.ok) {
    line("transcript", `FAIL/${trList.status}`, trList.error || "");
  } else if (!trList.items.length) {
    line("transcript", "EMPTY", "list OK but 0 transcripts (was Transcription on?)");
  } else {
    const newest = [...trList.items].reverse()[0];
    const content = await getTranscriptContentProbe(ctx.ownerId, ctx.meetingId, newest.id);
    if (content.ok) {
      line(
        "transcript",
        "OK",
        `${trList.items.length} item(s), content ${content.chars} chars, type=${content.contentType || "?"}`
      );
      if (content.preview) console.log(`                 preview: ${content.preview}`);
    } else {
      line(
        "transcript",
        `LIST_OK/CONTENT_${content.status}`,
        `${trList.items.length} item(s) but content failed: ${content.error || ""}`
      );
    }
  }

  // 2) Recording
  const recList = await listRecordings(ctx.ownerId, ctx.meetingId);
  if (!recList.ok) {
    line("recording", `FAIL/${recList.status}`, recList.error || "");
  } else if (!recList.items.length) {
    line("recording", "EMPTY", "list OK but 0 recordings (was Recording on?)");
  } else {
    const newest = [...recList.items].reverse()[0];
    const content = await probeRecordingContent(ctx.ownerId, ctx.meetingId, newest.id);
    if (content.ok) {
      line(
        "recording",
        "OK",
        `${recList.items.length} item(s), content HTTP ${content.status}, bytes=${content.bytes ?? "?"}, type=${content.contentType || "?"}`
      );
    } else {
      line(
        "recording",
        `LIST_OK/CONTENT_${content.status}`,
        `${recList.items.length} item(s) but content failed: ${content.error || ""}`
      );
    }
  }

  // 3) AI Insights
  const aiList = await listAiInsights(ctx.ownerId, ctx.meetingId);
  if (!aiList.ok) {
    line("aiInsights", `FAIL/${aiList.status}`, aiList.error || "");
  } else if (!aiList.items.length) {
    line("aiInsights", "EMPTY", "list OK but 0 insights (Copilot license / wait up to ~4h?)");
  } else {
    const first = aiList.items[0];
    const detail = await getAiInsight(ctx.ownerId, ctx.meetingId, first.id);
    if (detail.ok) {
      line(
        "aiInsights",
        "OK",
        `${aiList.items.length} item(s), detail ${detail.chars} chars, keys=${(detail.jsonKeys || []).join(",")}`
      );
      if (detail.preview) console.log(`                 preview: ${detail.preview}`);
    } else {
      line(
        "aiInsights",
        `LIST_OK/GET_${detail.status}`,
        `${aiList.items.length} item(s) but get failed: ${detail.error || ""}`
      );
    }
  }

  console.log("");
  console.log("--- how to read statuses ---");
  console.log("  OK        = API worked and returned usable content");
  console.log("  EMPTY     = permission/path OK, but meeting has no artifact yet");
  console.log("  FAIL/403  = missing app permission, CsApplicationAccessPolicy, or consent");
  console.log("  FAIL/401  = token/auth issue");
  console.log("  FAIL/402  = metered API / billing required");
  console.log("  FAIL/404  = path/API not available or meeting not found under that owner");
  console.log("");
  console.log("Done.");
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
