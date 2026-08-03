import { NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";
import { admin, assertConfigured } from "@/lib/supabaseServer";

// Monitor feed for the /monitor "AI at work" view.
// Auth: any signed-in M365 user (Bearer id token) in production. Local dev
// (`next dev`, NODE_ENV=development) is open — no login — so the room can be
// watched while working locally. Returns recent pipeline STAGE events (no
// message content is ever stored). Client polls with ?since=.
export const dynamic = "force-dynamic";

// Online (Vercel) → NODE_ENV=production → login required. Local `next dev` → open.
const REQUIRE_LOGIN = process.env.NODE_ENV === "production";

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
function shortUser(upn: string | null): string {
  if (!upn) return "—";
  return upn.split("@")[0] || upn;
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
  const sinceId = Number(url.searchParams.get("since") || "0") || 0;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || "200") || 200));

  let query = admin
    .from("agent_traces")
    .select("id,trace_id,upn,channel,step,label,status,seq,ms,created_at")
    .order("id", { ascending: true })
    .limit(limit);

  // First load (since=0): show the most recent window so the room isn't empty.
  if (sinceId > 0) {
    query = query.gt("id", sinceId);
  } else {
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
      return NextResponse.json({ events: [], cursor: sinceId, note: "agent_traces table not found — run supabase/migration_agent_traces.sql" });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data as TraceRow[]) || [];
  if (sinceId <= 0) rows.reverse(); // newest-first fetch → chronological for the client

  const events = rows.map((r) => ({
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
  }));

  const cursor = events.length ? events[events.length - 1].id : sinceId;
  return NextResponse.json({ events, cursor });
}
