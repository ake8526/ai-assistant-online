import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { admin, assertConfigured } from "@/lib/supabaseServer";

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
    outcome: "ok" | "error" | "incomplete";
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
    const delivered = list.some((r) => r.step === "reply" && r.status !== "error");
    // No reply stage and no error row = the request died mid-flight (timeout,
    // crash, or a throw that was swallowed) — the single most useful thing to
    // see when auditing a morning that never arrived.
    const outcome: Job["outcome"] = hasError ? "error" : delivered ? "ok" : "incomplete";
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

  const shown = problemsOnly ? jobs.filter((j) => j.outcome !== "ok") : jobs;

  const users = [...new Set(jobs.map((j) => j.user))].sort();
  const channels = [...new Set(jobs.map((j) => j.channel))].sort();

  return NextResponse.json({
    date,
    truncated: rows.length >= MAX_ROWS,
    summary: {
      traces: jobs.length,
      events: rows.length,
      ok: jobs.filter((j) => j.outcome === "ok").length,
      errors: jobs.filter((j) => j.outcome === "error").length,
      incomplete: jobs.filter((j) => j.outcome === "incomplete").length,
      users,
      channels,
    },
    traces: shown,
  });
}
