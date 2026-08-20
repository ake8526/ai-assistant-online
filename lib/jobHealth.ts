// Stop firing a scheduled job that is not finishing.
//
// The polling jobs run every few minutes forever. When one starts dying
// mid-flight — LINE quota gone, Graph timing out, a throw the route swallows —
// the scheduler happily fires it again on the next tick, so /monitor/log fills
// with identical corpses and any half-done work (a LINE push that went out
// before the crash) can repeat. Pausing was a manual button only.
//
// So: before a job runs, look at its own recent history. If it has been failing
// to finish for longer than STALL_AFTER_MS, pause it the same way the button
// does (until midnight Bangkok, expiry included) and record why.
//
// The judgement itself lives in lib/jobStall.ts; this file is the I/O around it.
import { admin } from "@/lib/supabaseServer";
import {
  PAUSABLE_JOBS,
  PausableJob,
  isJobPaused,
  pauseJobs,
  pauseState,
} from "@/lib/opsPause";
import { decideStall, STALL_AFTER_MS, type JobRun, type StallReport } from "@/lib/jobStall";
import { runWithTrace, trace } from "@/lib/trace";

function jobDef(job: PausableJob) {
  const def = PAUSABLE_JOBS.find((j) => j.key === job);
  if (!def) throw new Error(`unknown job ${job}`);
  return def;
}

/** Read this job's recent runs out of the trace log. */
async function recentRuns(traceTitle: string): Promise<JobRun[]> {
  const since = new Date(Date.now() - 2 * STALL_AFTER_MS).toISOString();

  // A run of this job = a receive row carrying its title.
  const { data: starts, error } = await admin
    .from("agent_traces")
    .select("trace_id,created_at")
    .eq("step", "receive")
    .eq("label", traceTitle)
    .gte("created_at", since)
    .order("id", { ascending: false })
    .limit(200);
  if (error || !starts?.length) return [];

  const startedAt = new Map<string, number>();
  for (const r of starts) {
    startedAt.set(r.trace_id as string, Date.parse(r.created_at as string));
  }
  const ids = [...startedAt.keys()];

  // Which of those runs reached an ending, and was it an error?
  // (`in` goes in the URL — batch it.)
  const ended = new Set<string>();
  const failed = new Set<string>();
  const BATCH = 60;
  for (let i = 0; i < ids.length; i += BATCH) {
    const { data } = await admin
      .from("agent_traces")
      .select("trace_id,step,status")
      .in("trace_id", ids.slice(i, i + BATCH));
    for (const r of data || []) {
      const id = r.trace_id as string;
      if (r.step === "reply" || r.step === "error" || r.status === "error") ended.add(id);
      if (r.step === "error" || r.status === "error") failed.add(id);
    }
  }

  return ids.map((id) => ({
    startedAt: startedAt.get(id) as number,
    ended: ended.has(id),
    failed: failed.has(id),
  }));
}

/** Has `job` been failing to finish for over half an hour? */
export async function jobStallReport(job: PausableJob): Promise<StallReport> {
  const runs = await recentRuns(jobDef(job).traceTitle);
  return decideStall(runs, Date.now());
}

/**
 * Gate for a cron job: returns a reason to skip, or null to go ahead.
 * Covers the manual pause too, so a caller has one thing to ask.
 */
export async function jobSkipReason(job: PausableJob): Promise<string | null> {
  if (await isJobPaused(job)) return "paused";

  let report: StallReport;
  try {
    report = await jobStallReport(job);
  } catch {
    return null; // a failed health check must never be why a healthy job stops
  }
  if (!report.stalled) return null;

  const { key, label } = jobDef(job);
  const current = await pauseState();
  const jobs = current?.jobs.includes(key) ? current.jobs : [...(current?.jobs || []), key];
  await pauseJobs(jobs);

  const what =
    report.reason === "failing"
      ? `ผิดพลาด ${report.failures} รอบติด`
      : `ไม่จบงาน ${report.unfinished} รอบติด`;

  // Say it out loud in the same log as the runs that caused it.
  await runWithTrace({ channel: "ops" }, async () => {
    trace("receive", `หยุดงานอัตโนมัติ · ${label}`);
    trace(
      "error",
      `${label} ${what} ต่อเนื่อง ${report.sinceMin} นาที — หยุดยิงซ้ำถึงเที่ยงคืน · ` +
        `แก้ต้นเหตุแล้วกด “เปิดกลับเลย” ที่ /monitor/log`,
      "error"
    );
  });

  return `auto-paused (${report.reason}): ${what}, ${report.sinceMin}m`;
}
