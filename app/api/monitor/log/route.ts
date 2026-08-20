import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { PAUSABLE_JOBS, pauseState } from "@/lib/opsPause";
import { searchUsers } from "@/lib/graph";
import { getSetting, setSetting } from "@/lib/store";

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

/**
 * Mailbox → the name people use for each other.
 *
 * "natthakrit.b" is a mailbox, not a person; on a page whose whole job is
 * telling you who was served, it should say the name shown in the directory.
 * Resolved through Graph and kept in one settings row, because names change
 * about never and the alternative is a directory call per user per refresh.
 */
const NAMES_KEY = "display_names";
const NAMES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function displayNames(upns: string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(upns.filter((u) => u && u.includes("@")).map((u) => u.toLowerCase()))];
  if (!wanted.length) return {};

  let cache: Record<string, { name: string; ts: number }> = {};
  try {
    const raw = await getSetting("_ops", NAMES_KEY);
    if (raw) cache = JSON.parse(raw) as typeof cache;
  } catch {
    cache = {};
  }

  const now = Date.now();
  const missing = wanted.filter((u) => !cache[u]?.name || now - (cache[u]?.ts || 0) > NAMES_TTL_MS);
  if (missing.length) {
    await Promise.all(
      missing.map(async (upn) => {
        try {
          const hit = (await searchUsers(upn, 1))[0];
          const name = (hit?.displayName || "").trim();
          // A lookup that just echoes the address is not a name — do not cache it
          // as one, or the page shows the mailbox forever.
          if (name && !name.includes("@")) cache[upn] = { name, ts: now };
        } catch {
          /* a directory hiccup must not fail the page */
        }
      })
    );
    try {
      await setSetting("_ops", NAMES_KEY, JSON.stringify(cache));
    } catch {
      /* cache is an optimisation, not a requirement */
    }
  }

  // Keyed by BOTH the full address and the local part, since the rows carry the
  // short form and the client should not have to guess.
  const out: Record<string, string> = {};
  for (const upn of wanted) {
    const name = cache[upn]?.name;
    if (!name) continue;
    out[upn] = name;
    out[shortUser(upn)] = name;
  }
  return out;
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


/** Which days of a month actually hold trace rows — the calendar greys out the
 *  rest, so a day that cannot show anything cannot be picked. One small COUNT
 *  per day (head-only, served by the created_at index) rather than pulling a
 *  month of stages just to learn which days exist. */
async function daysWithLogs(month: string): Promise<Response> {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) {
    return NextResponse.json({ error: "bad month" }, { status: 400 });
  }
  const today = bkkToday();
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const candidates: string[] = [];
  for (let d = 1; d <= total; d++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso <= today) candidates.push(iso);
  }

  const counted = await Promise.all(
    candidates.map(async (iso) => {
      const { from, to } = bkkDayRange(iso);
      const { count, error } = await admin
        .from("agent_traces")
        .select("id", { count: "exact", head: true })
        .gte("created_at", from)
        .lt("created_at", to);
      if (error) return { iso, n: 0, failed: true };
      return { iso, n: count || 0, failed: false };
    })
  );

  // A failed probe must not hide a day that does have log — better to offer a
  // day that turns out empty than to lock the user out of it.
  const days = counted.filter((c) => c.failed || c.n > 0).map((c) => c.iso);
  const counts: Record<string, number> = {};
  for (const c of counted) if (c.n) counts[c.iso] = c.n;
  return NextResponse.json({ month, days, counts });
}

export async function GET(req: Request) {
  const gate = await guard(req, "log.view");
  if (!gate.ok) return gate.response;

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
  // Clicking a count chip filters by that outcome; "problems" = error + incomplete.
  const outcome = (url.searchParams.get("outcome") || "").toLowerCase();

  // live=1 — "what is running right NOW". Deliberately its own tiny query
  // (last few minutes, no filters) so the page can poll it every few seconds
  // without re-reading a whole day of stages each time.
  if (url.searchParams.get("live") === "1") {
    return liveNow();
  }

  // days=YYYY-MM — for the calendar: which days of that month have any log.
  const monthParam = (url.searchParams.get("days") || "").trim();
  if (/^\d{4}-\d{2}$/.test(monthParam)) {
    return daysWithLogs(monthParam);
  }

  const { from, to } = bkkDayRange(date);

  // The filter box takes a nickname, because that is how people refer to each
  // other here — but a trace is stamped with a UPN like "weerasak.pi". A Thai
  // (or otherwise non-roman) query is resolved through the directory first, so
  // "เอก" finds Weerasak. Roman text stays a plain prefix match, which is both
  // faster and lets a partial UPN work.
  let resolved: { mail: string; name: string }[] | null = null;
  if (user && !/^[ -~]+$/.test(user)) {
    try {
      resolved = (await searchUsers(user, 8))
        .filter((u) => u.mail)
        .map((u) => ({ mail: u.mail.toLowerCase(), name: u.displayName || u.mail }));
    } catch {
      resolved = [];
    }
    if (!resolved.length) {
      return NextResponse.json({
        date,
        today: date === bkkToday(),
        perms: gate.perms,
        userQuery: user,
        resolvedUsers: [],
        summary: { traces: 0, events: 0, ok: 0, quiet: 0, errors: 0, incomplete: 0, users: [], channels: [] },
        activity: [],
        traces: [],
        note: `ไม่พบผู้ใช้ชื่อ “${user}” ในไดเรกทอรี M365`,
      });
    }
  }

  // A label or step filter matches a SINGLE STAGE, but the unit of this page is
  // the job. Filtering rows directly returned just the matching stage of each
  // job, so every job arrived with one lonely row: no ending stage → counted as
  // "ไม่จบงาน", and opening it showed a one-line detail with no user attached.
  // Clicking "เตือนนัดค้างตอบ" in the activity table (which sets q=title, and a
  // title only ever appears on the receive row) made that the normal case.
  //
  // So: when such a filter is on, first collect the trace_ids that match, then
  // fetch those jobs whole. The filter now means "jobs that contain a matching
  // stage", which is what a person reading this page means by it.
  const PAGE = 1000;
  const stageFilter = !traceId && (!!q || !!step);
  let matchedTraceIds: string[] | null = null;
  if (stageFilter) {
    const ids = new Set<string>();
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      let idq = admin
        .from("agent_traces")
        .select("trace_id")
        .gte("created_at", from)
        .lt("created_at", to)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (resolved) idq = idq.in("upn", resolved.map((r) => r.mail));
      else if (user) idq = idq.ilike("upn", `${user}%`);
      if (channel) idq = idq.eq("channel", channel);
      if (step) idq = idq.eq("step", step);
      if (q) idq = idq.ilike("label", `%${q}%`);

      const { data, error } = await idq;
      if (error) {
        if (tableMissing(error as { code?: string; message?: string })) break;
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const page = (data as { trace_id: string }[]) || [];
      for (const r of page) ids.add(r.trace_id);
      if (page.length < PAGE) break;
    }
    matchedTraceIds = [...ids];
    if (!matchedTraceIds.length) {
      return NextResponse.json({
        date,
        today: date === bkkToday(),
        perms: gate.perms,
        resolvedUsers: resolved,
        activityWindowMin: 30,
        activity: [],
        shownCount: 0,
        matchedCount: 0,
        summary: { traces: 0, events: 0, ok: 0, quiet: 0, errors: 0, incomplete: 0, users: [], channels: [] },
        traces: [],
      });
    }
  }

  // PostgREST caps a single response at 1000 rows, and one busy morning easily
  // passes that — page through so a day is never silently cut short.
  const rows: TraceRow[] = [];
  // An `in` list goes into the URL, so ask for the jobs in batches.
  const ID_BATCH = 60;
  const idBatches: (string[] | null)[] = matchedTraceIds
    ? Array.from({ length: Math.ceil(matchedTraceIds.length / ID_BATCH) }, (_, i) =>
        matchedTraceIds!.slice(i * ID_BATCH, (i + 1) * ID_BATCH)
      )
    : [null];

  for (const batch of idBatches) {
   for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    let query = admin
      .from("agent_traces")
      .select("id,trace_id,upn,channel,step,label,status,seq,ms,created_at")
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (traceId) {
      // A single job — ignore the day window so a trace can be opened from any day.
      query = query.eq("trace_id", traceId);
    } else if (batch) {
      // Whole jobs, selected above. No stage filter here — that is the point.
      query = query.in("trace_id", batch);
    } else {
      query = query.gte("created_at", from).lt("created_at", to);
      if (resolved) query = query.in("upn", resolved.map((r) => r.mail));
      else if (user) query = query.ilike("upn", `${user}%`);
      if (channel) query = query.eq("channel", channel);
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
    /** Plain-language answer to "what is this, why is it stuck, is it still stuck?" */
    diagnosis?: string;
    events: { clock: string; step: string; label: string; status: string; ms: number }[];
  };

  const byTrace = new Map<string, TraceRow[]>();
  for (const r of rows) {
    const list = byTrace.get(r.trace_id);
    if (list) list.push(r);
    else byTrace.set(r.trace_id, [r]);
  }

  /** A job that stopped without an ending: say what that means in words. */
  function explain(lastStep: string, quietSec: number): string {
    if (quietSec < 45) return "กำลังทำอยู่ตอนนี้ — ยังไม่จบ ให้รอสักครู่แล้วรีเฟรช";
    const idle =
      quietSec < 3600
        ? `เงียบมา ${Math.round(quietSec / 60)} นาที`
        : `เงียบมา ${Math.round(quietSec / 3600)} ชั่วโมง`;
    const why: Record<string, string> = {
      receive:
        "หยุดตั้งแต่เพิ่งรับงาน ยังไม่ได้เริ่มทำอะไรเลย — มักเกิดกับงานเบื้องหลังที่ถูกตัดกลางคัน (ตัวที่เรียกไม่ได้รอผล) หรือเซิร์ฟเวอร์ปิดฟังก์ชันก่อนงานได้เริ่ม",
      parse: "หยุดตอนกำลังตีความคำสั่ง — มัก AI ตอบช้าหรือล้มเหลว",
      fetch: "หยุดระหว่างดึงข้อมูล — มัก M365 หรือแหล่งข่าวตอบช้าเกินเวลาที่ตั้งไว้",
      compose:
        "เขียนคำตอบเสร็จแล้วแต่ไม่มีขั้นส่งออก — มักเป็นการส่ง LINE ที่ล้มเหลว เช่น โควตาส่งหมด",
    };
    const cause = why[lastStep] || "หยุดกลางทางโดยไม่ได้บันทึกสาเหตุ";
    return `${cause} · ${idle} แล้ว จึงถือว่าหยุดไปแล้ว ไม่ได้ทำงานอยู่ และจะไม่ทำต่อเอง`;
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
      diagnosis:
        outcome === "incomplete"
          ? explain(last.step, Math.max(0, (Date.now() - Date.parse(last.created_at)) / 1000))
          : undefined,
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

  // A bad morning can leave hundreds of matching jobs. Rendering every one of
  // them locks the page up, so cap what is sent and say so — the counts above
  // still come from the full day.
  const SHOW_LIMIT = 300;
  const wantProblems = problemsOnly || outcome === "problems";
  const matched = wantProblems
    ? jobs.filter((j) => j.outcome === "error" || j.outcome === "incomplete")
    : outcome
      ? jobs.filter((j) => j.outcome === outcome)
      : jobs;
  const shown = matched.slice(0, SHOW_LIMIT);

  const users = [...new Set(jobs.map((j) => j.user))].sort();
  const channels = [...new Set(jobs.map((j) => j.channel))].sort();

  // "งานที่วนอยู่ตอนนี้" — the recurring jobs seen in the last window, folded by
  // job name. Answers "is anything running right now?" from the page itself
  // instead of having to read a wall of identical rows.
  const ACTIVITY_WINDOW_MS = 30 * 60_000;
  const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
  const pausedState = await pauseState();
  const pausedTitles = new Set(
    (pausedState?.jobs || [])
      .map((j) => PAUSABLE_JOBS.find((p) => p.key === j)?.traceTitle)
      .filter((t): t is string => !!t)
  );
  const recent = jobs.filter(
    (j) =>
      Date.parse(j.startedAt) >= cutoff &&
      // Recurring scheduled work only — a LINE conversation or a button press on
      // this page is a one-off, and belongs in the list below, not here.
      j.channel === "cron" &&
      // Stopped means gone. It comes back on its own the next time it runs.
      !pausedTitles.has(j.title)
  );
  const groups = new Map<string, Job[]>();
  for (const j of recent) {
    const list = groups.get(j.title);
    if (list) list.push(j);
    else groups.set(j.title, [j]);
  }
  /** For a failed job: the stage that carries the reason, which is the last
   *  error stage — or the last stage at all when it died without saying why. */
  function failureLabel(j: Job): string {
    const err = [...j.events].reverse().find((e) => e.status === "error" || e.step === "error");
    const last = j.events[j.events.length - 1];
    return (err?.label || last?.label || "ไม่ได้บันทึกสาเหตุ").slice(0, 140);
  }

  const activity = [...groups.entries()]
    .map(([title, list]) => {
      const newest = list[0]; // jobs are newest-first

      // A count of problems answers "how many" and nothing else; the two
      // questions actually being asked of this table are "who" and "why".
      // Fold the failures by reason, keeping the people and one trace id per
      // reason so the row can open the job that proves it.
      const byReason = new Map<
        string,
        { n: number; users: Set<string>; traceId: string; lastClock: string }
      >();
      for (const j of list) {
        if (j.outcome !== "error" && j.outcome !== "incomplete") continue;
        const label = j.outcome === "incomplete" ? `ค้างที่ขั้น “${j.events[j.events.length - 1]?.step || "?"}” · ไม่ได้บันทึกสาเหตุ` : failureLabel(j);
        const hit = byReason.get(label);
        if (hit) {
          hit.n++;
          hit.users.add(j.user);
        } else {
          byReason.set(label, { n: 1, users: new Set([j.user]), traceId: j.traceId, lastClock: j.clock });
        }
      }

      // Per person, so a row can be opened instead of read as one blur: four
      // quiet runs for one colleague and four failures for another are not the
      // same morning, and the folded row cannot tell them apart.
      const perUser = new Map<
        string,
        { user: string; runs: number; ok: number; quiet: number; errors: number; incomplete: number; lastClock: string }
      >();
      for (const j of list) {
        const row =
          perUser.get(j.user) ||
          { user: j.user, runs: 0, ok: 0, quiet: 0, errors: 0, incomplete: 0, lastClock: j.clock };
        row.runs++;
        // the outcome is called "error"; the tally field is "errors"
        if (j.outcome === "error") row.errors++;
        else row[j.outcome]++;
        perUser.set(j.user, row);
      }

      return {
        title,
        runs: list.length,
        users: [...new Set(list.map((j) => j.user))].length,
        /** Who this job ran for — the count alone could not be clicked into. */
        userList: [...new Set(list.map((j) => j.user))].slice(0, 12),
        byUser: [...perUser.values()].sort(
          (a, b) => b.errors + b.incomplete - (a.errors + a.incomplete) || b.runs - a.runs
        ),
        lastClock: newest.clock,
        lastAgoSec: Math.max(0, Math.round((Date.now() - Date.parse(newest.startedAt)) / 1000)),
        ok: list.filter((j) => j.outcome === "ok").length,
        quiet: list.filter((j) => j.outcome === "quiet").length,
        errors: list.filter((j) => j.outcome === "error").length,
        incomplete: list.filter((j) => j.outcome === "incomplete").length,
        channel: newest.channel,
        reasons: [...byReason.entries()]
          .sort((a, b) => b[1].n - a[1].n)
          .slice(0, 4)
          .map(([label, v]) => ({
            label,
            n: v.n,
            users: [...v.users].slice(0, 8),
            traceId: v.traceId,
            clock: v.lastClock,
          })),
      };
    })
    .sort((a, b) => a.lastAgoSec - b.lastAgoSec);

  // Every mailbox that appears anywhere in this response, resolved once.
  const names = await displayNames([...new Set(rows.map((r) => r.upn || "").filter(Boolean))]);

  return NextResponse.json({
    date,
    today: date === bkkToday(),
    perms: gate.perms,
    resolvedUsers: resolved,
    names,
    truncated: rows.length >= MAX_ROWS,
    activityWindowMin: ACTIVITY_WINDOW_MS / 60_000,
    activity,
    shownCount: shown.length,
    matchedCount: matched.length,
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
