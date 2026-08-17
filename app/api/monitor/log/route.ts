import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { PAUSABLE_JOBS, pauseState } from "@/lib/opsPause";

// History feed for /monitor/log — "ดู log ย้อนหลัง".
//
// /api/monitor/events is a LIVE tail (cursor-based, tip-seeded) and cannot look
// backwards. This route queries the same agent_traces table by Bangkok DAY plus
// filters, and groups rows into traces (one job = one incoming request) so a
// morning can be audited: who was served, at what minute, and where it stopped.
//
// Auth: same rule as the live feed — signed-in M365 user in production, open in
// local dev. Content is stages only; no message text is ever stored.
export const dynamic = "force-dynamic";

const REQUIRE_LOGIN = process.env.NODE_ENV === "production";

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_ROWS = 5000;

type TraceRow = {
  id: number;
  trace_id: string;
  upn: string | null;
  channel: string | null;
  step: string;
  label: string | null;
  status: string;
  seq: number;
  ms: number | null;
  created_at: string;
};

/** Local part only — enough to tell users apart, minimal PII (same as the live feed). */
function shortUser(upn: string | null): string {
  if (!upn) return "—";
  return upn.split("@")[0] || upn;
}

/** Today in Bangkok, as YYYY-MM-DD. */
function bkkToday(): string {
  return new Date(Date.now() + BKK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Bangkok calendar day → UTC half-open range [from, to). */
function bkkDayRange(date: string): { from: string; to: string } {
  const start = Date.parse(`${date}T00:00:00Z`) - BKK_OFFSET_MS;
  return {
    from: new Date(start).toISOString(),
    to: new Date(start + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** HH:MM:SS in Bangkok. */
function bkkClock(iso: string): string {
  return new Date(Date.parse(iso) + BKK_OFFSET_MS).toISOString().slice(11, 19);
}

function tableMissing(error: { code?: string; message?: string }): boolean {
  const code = error.code || "";
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /could not find the table|schema cache|does not exist/i.test(error.message || "")
  );
}

/** How long after its last stage a job is still presumed to be working. Stages
 *  land seconds apart; past this a silent trace is finished (or dead), not busy. */
const RUNNING_QUIET_MS = 45_000;
/** Lookback for the live query — a long job (meeting summaries, up to 300s)
 *  must still be visible while it runs. */
const LIVE_WINDOW_MS = 6 * 60_000;

/** Jobs with no terminal stage yet and a stage seen moments ago = in flight. */
async function liveNow(): Promise<Response> {
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from("agent_traces")
    .select("id,trace_id,upn,channel,step,label,status,seq,ms,created_at")
    .gte("created_at", since)
    .order("id", { ascending: true })
    .limit(1000);

  if (error) {
    if (tableMissing(error as { code?: string; message?: string })) {
      return NextResponse.json({ running: [], now: bkkClock(new Date().toISOString()) });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const byTrace = new Map<string, TraceRow[]>();
  for (const r of (data as TraceRow[]) || []) {
    const list = byTrace.get(r.trace_id);
    if (list) list.push(r);
    else byTrace.set(r.trace_id, [r]);
  }

  const now = Date.now();
  const running = [];
  for (const [tid, list] of byTrace) {
    list.sort((a, b) => a.seq - b.seq || a.id - b.id);
    const done = list.some(
      (r) => r.step === "reply" || r.step === "error" || r.status === "error"
    );
    if (done) continue;
    const last = list[list.length - 1];
    const quietMs = now - Date.parse(last.created_at);
    if (quietMs > RUNNING_QUIET_MS) continue; // silent too long — not working, stuck or gone
    running.push({
      traceId: tid,
      user: shortUser(list[0].upn),
      channel: list[0].channel || "?",
      // Trace rows are written concurrently, so a job caught in its first
      // second may not have its "receive" row yet — showing the Graph URL that
      // did land as the job name reads like nonsense. Wait for the real name.
      title: list.find((r) => r.step === "receive")?.label || "(กำลังเริ่ม…)",
      step: last.step,
      stepLabel: last.label || "",
      startedClock: bkkClock(list[0].created_at),
      elapsedSec: Math.max(0, Math.round((now - Date.parse(list[0].created_at)) / 1000)),
      stages: list.length,
    });
  }
  running.sort((a, b) => b.elapsedSec - a.elapsedSec);

  const paused = await pauseState();

  return NextResponse.json({
    running,
    paused: paused
      ? {
          jobs: paused.jobs,
          labels: paused.jobs.map(
            (j) => PAUSABLE_JOBS.find((p) => p.key === j)?.label || j
          ),
          untilClock: bkkClock(new Date(paused.until).toISOString()),
        }
      : null,
    now: bkkClock(new Date().toISOString()),
    quietCutoffSec: RUNNING_QUIET_MS / 1000,
  });
}

export async function GET(req: Request) {
  if (REQUIRE_LOGIN) {
    try {
      await requireUser(req);
    } catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
      return NextResponse.json({ error: "auth failed" }, { status: 401 });
    }
  }

  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  const url = new URL(req.url);
  const rawDate = (url.searchParams.get("date") || "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : bkkToday();
  const user = (url.searchParams.get("user") || "").trim().toLowerCase();
  const channel = (url.searchParams.get("channel") || "").trim().toLowerCase();
  const step = (url.searchParams.get("step") || "").trim().toLowerCase();
  const q = (url.searchParams.get("q") || "").trim();
  const traceId = (url.searchParams.get("trace") || "").trim();
  const problemsOnly = url.searchParams.get("problems") === "1";

  // live=1 — "what is running right NOW". Deliberately its own tiny query
  // (last few minutes, no filters) so the page can poll it every few seconds
  // without re-reading a whole day of stages each time.
  if (url.searchParams.get("live") === "1") {
    return liveNow();
  }

  const { from, to } = bkkDayRange(date);

  // PostgREST caps a single response at 1000 rows, and one busy morning easily
  // passes that — page through so a day is never silently cut short.
  const PAGE = 1000;
  const rows: TraceRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    let query = admin
      .from("agent_traces")
      .select("id,trace_id,upn,channel,step,label,status,seq,ms,created_at")
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (traceId) {
      // A single job — ignore the day window so a trace can be opened from any day.
      query = query.eq("trace_id", traceId);
    } else {
      query = query.gte("created_at", from).lt("created_at", to);
      if (user) query = query.ilike("upn", `${user}%`);
      if (channel) query = query.eq("channel", channel);
      if (step) query = query.eq("step", step);
      if (q) query = query.ilike("label", `%${q}%`);
    }

    const { data, error } = await query;
    if (error) {
      if (tableMissing(error as { code?: string; message?: string })) {
        return NextResponse.json({
          date,
          traces: [],
          summary: { traces: 0, events: 0, errors: 0, users: [], channels: [] },
          note: "agent_traces table not found — run supabase/migration_agent_traces.sql",
        });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const page = (data as TraceRow[]) || [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  // Group into jobs. A trace = one incoming request (LINE message, cron tick, …)
  // so the log reads as "งาน" rather than a wall of stage rows.
  type Job = {
    traceId: string;
    user: string;
    channel: string;
    startedAt: string;
    clock: string;
    durationMs: number;
    title: string;
    outcome: "ok" | "quiet" | "error" | "incomplete";
    events: { clock: string; step: string; label: string; status: string; ms: number }[];
  };

  const byTrace = new Map<string, TraceRow[]>();
  for (const r of rows) {
    const list = byTrace.get(r.trace_id);
    if (list) list.push(r);
    else byTrace.set(r.trace_id, [r]);
  }

  const jobs: Job[] = [];
  for (const [tid, list] of byTrace) {
    list.sort((a, b) => a.seq - b.seq || a.id - b.id);
    const first = list[0];
    const last = list[list.length - 1];
    const hasError = list.some((r) => r.status === "error" || r.step === "error");
    const quiet = list.some((r) => r.step === "reply" && r.status === "skip");
    const delivered = list.some((r) => r.step === "reply" && r.status !== "error" && r.status !== "skip");
    // No reply stage and no error row = the request died mid-flight (timeout,
    // crash, or a throw that was swallowed) — the single most useful thing to
    // see when auditing a morning that never arrived. A run that finished with
    // nothing to send says so ("skip") and must not be counted as a casualty.
    const outcome: Job["outcome"] = hasError
      ? "error"
      : delivered
        ? "ok"
        : quiet
          ? "quiet"
          : "incomplete";
    jobs.push({
      traceId: tid,
      user: shortUser(first.upn),
      channel: first.channel || "?",
      startedAt: first.created_at,
      clock: bkkClock(first.created_at),
      durationMs: Math.max(0, (last.ms ?? 0) - (first.ms ?? 0)),
      title: list.find((r) => r.step === "receive")?.label || first.label || first.step,
      outcome,
      events: list.map((r) => ({
        clock: bkkClock(r.created_at),
        step: r.step,
        label: r.label || "",
        status: r.status,
        ms: r.ms ?? 0,
      })),
    });
  }

  jobs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0)); // newest first

  const shown = problemsOnly
    ? jobs.filter((j) => j.outcome === "error" || j.outcome === "incomplete")
    : jobs;

  const users = [...new Set(jobs.map((j) => j.user))].sort();
  const channels = [...new Set(jobs.map((j) => j.channel))].sort();

  // "งานที่วนอยู่ตอนนี้" — the recurring jobs seen in the last window, folded by
  // job name. Answers "is anything running right now?" from the page itself
  // instead of having to read a wall of identical rows.
  const ACTIVITY_WINDOW_MS = 30 * 60_000;
  const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
  const recent = jobs.filter((j) => Date.parse(j.startedAt) >= cutoff);
  const groups = new Map<string, Job[]>();
  for (const j of recent) {
    const list = groups.get(j.title);
    if (list) list.push(j);
    else groups.set(j.title, [j]);
  }
  const activity = [...groups.entries()]
    .map(([title, list]) => {
      const newest = list[0]; // jobs are newest-first
      return {
        title,
        runs: list.length,
        users: [...new Set(list.map((j) => j.user))].length,
        lastClock: newest.clock,
        lastAgoSec: Math.max(0, Math.round((Date.now() - Date.parse(newest.startedAt)) / 1000)),
        ok: list.filter((j) => j.outcome === "ok").length,
        quiet: list.filter((j) => j.outcome === "quiet").length,
        errors: list.filter((j) => j.outcome === "error").length,
        incomplete: list.filter((j) => j.outcome === "incomplete").length,
        channel: newest.channel,
      };
    })
    .sort((a, b) => a.lastAgoSec - b.lastAgoSec);

  // Which of these recurring jobs are paused right now. The activity table is a
  // rear-view mirror: rows from before a pause stay visible until they age out,
  // and without this flag they read as "still running".
  const pausedState = await pauseState();
  const pausedTitles = (pausedState?.jobs || [])
    .map((j) => PAUSABLE_JOBS.find((p) => p.key === j)?.traceTitle)
    .filter((t): t is string => !!t);

  return NextResponse.json({
    date,
    today: date === bkkToday(),
    truncated: rows.length >= MAX_ROWS,
    activityWindowMin: ACTIVITY_WINDOW_MS / 60_000,
    pausedTitles,
    activity,
    summary: {
      traces: jobs.length,
      events: rows.length,
      ok: jobs.filter((j) => j.outcome === "ok").length,
      quiet: jobs.filter((j) => j.outcome === "quiet").length,
      errors: jobs.filter((j) => j.outcome === "error").length,
      incomplete: jobs.filter((j) => j.outcome === "incomplete").length,
      users,
      channels,
    },
    traces: shown,
  });
}
