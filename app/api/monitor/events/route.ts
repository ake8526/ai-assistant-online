import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { llmMonitorInfo } from "@/lib/llm";
import { admin, assertConfigured } from "@/lib/supabaseServer";

// Monitor feed for the /monitor "AI at work" view.
// Auth: any signed-in M365 user (Bearer id token) in production. Local dev
// (`next dev`, NODE_ENV=development) is open — no login — so the room can be
// watched while working locally. Returns recent pipeline STAGE events (no
// message content is ever stored). Client polls with ?since=.
export const dynamic = "force-dynamic";

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

// Only the local-part of the UPN is exposed to the browser (e.g. "weerasak"),
// never the full address — enough to tell requests apart, minimal PII.
/** How far back a freshly-opened room looks. Long enough to catch a job that is
 *  mid-flight or just finished; short enough that it is clearly "now". */
const CATCHUP_WINDOW_MS = 5 * 60_000;
const CATCHUP_LIMIT = 150;

function shortUser(upn: string | null): string {
  if (!upn) return "—";
  return upn.split("@")[0] || upn;
}

function toEvent(r: TraceRow) {
  return {
    id: r.id,
    traceId: r.trace_id,
    user: shortUser(r.upn),
    channel: r.channel || "?",
    step: r.step,
    label: r.label || "",
    status: r.status,
    seq: r.seq,
    ms: r.ms ?? 0,
    at: r.created_at,
  };
}

export async function GET(req: Request) {
  const gate = await guard(req, "monitor.view");
  if (!gate.ok) return gate.response;

  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  const url = new URL(req.url);
  const sinceId = Number(url.searchParams.get("since") || "0") || 0;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || "200") || 200));
  // replay=1 → first load returns recent history (demo). Default: seed cursor only so
  // refreshing /monitor does not look like the AI started work by itself.
  const replay = url.searchParams.get("replay") === "1";

  // First load (since=0): hand back the last few minutes so the room shows what
  // is happening the moment it is opened. Jumping straight to the tip made every
  // refresh look like an idle office until the next request happened to arrive —
  // you could not tell "nothing is running" from "I just pressed F5".
  if (sinceId <= 0 && !replay) {
    const since = new Date(Date.now() - CATCHUP_WINDOW_MS).toISOString();
    const { data, error } = await admin
      .from("agent_traces")
      .select("id,trace_id,upn,channel,step,label,status,seq,ms,created_at")
      .gte("created_at", since)
      .order("id", { ascending: true })
      .limit(CATCHUP_LIMIT);
    if (error) {
      const code = (error as { code?: string }).code || "";
      const missing =
        code === "42P01" ||
        code === "PGRST205" ||
        /could not find the table|schema cache|does not exist/i.test(error.message || "");
      if (missing) {
        return NextResponse.json({
          events: [],
          cursor: 0,
          note: "agent_traces table not found — run supabase/migration_agent_traces.sql",
          llm: llmMonitorInfo(),
        });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const recent = (data as TraceRow[]) || [];
    const cursor = recent.length ? recent[recent.length - 1].id : 0;
    return NextResponse.json({
      events: recent.map(toEvent),
      cursor,
      seeded: true,
      catchup: true, // the client plays these without pretending they arrived just now
      llm: llmMonitorInfo(),
    });
  }

  let query = admin
    .from("agent_traces")
    .select("id,trace_id,upn,channel,step,label,status,seq,ms,created_at")
    .order("id", { ascending: true })
    .limit(limit);

  if (sinceId > 0) {
    query = query.gt("id", sinceId);
  } else {
    // replay=1 demo mode: last 60 events
    query = admin
      .from("agent_traces")
      .select("id,trace_id,upn,channel,step,label,status,seq,ms,created_at")
      .order("id", { ascending: false })
      .limit(60);
  }

  const { data, error } = await query;
  if (error) {
    // Migration not run yet → table missing. Postgres reports 42P01; PostgREST
    // (Supabase) reports PGRST205 / "Could not find the table … in the schema
    // cache". Treat as "no events" so the room renders quietly instead of erroring.
    const code = (error as { code?: string }).code || "";
    const missing = code === "42P01" || code === "PGRST205" || /could not find the table|schema cache|does not exist/i.test(error.message || "");
    if (missing) {
      return NextResponse.json({
        events: [],
        cursor: sinceId,
        note: "agent_traces table not found — run supabase/migration_agent_traces.sql",
        llm: llmMonitorInfo(),
      });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data as TraceRow[]) || [];
  if (sinceId <= 0) rows.reverse(); // newest-first fetch → chronological for the client

  const events = rows.map(toEvent);

  const cursor = events.length ? events[events.length - 1].id : sinceId;
  return NextResponse.json({ events, cursor, llm: llmMonitorInfo() });
}
