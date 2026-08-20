// When is a recurring job "stuck" rather than merely having a bad tick?
//
// Kept separate from lib/jobHealth.ts (which does the Supabase reads and the
// pausing) so this judgement is a plain function over plain data: it is the part
// that decides whether the scheduler stops firing a job, and it must be
// inspectable and testable on its own.
//
// Two ways a job is stuck, and both must stop it firing:
//   hung    — runs start and never reach an ending (a crash the route swallowed,
//             a timeout, a function frozen mid-flight)
//   failing — runs do reach an ending, and it is an error, every single time
//             (LINE quota gone, Graph refusing, a bad token)
// The second one was left out at first, on the grounds that a job reporting its
// own error is a visible fault and hiding it would be worse. But 48 identical
// failures in half an hour is not a report, it is a loop: it buries the log,
// burns Graph and LLM calls on work that cannot land, and can repeat half-done
// side effects. Pausing writes its reason into the same log, the history stays,
// the pause expires at midnight, and a person can resume it in one click.

/** How long a job may keep failing (either way) before it is paused. */
export const STALL_AFTER_MS = 30 * 60_000;
/** Never judge on one run — a single bad tick is usually a cold start. */
export const MIN_STALLED_RUNS = 3;
/** A run younger than this may simply still be working. */
export const GRACE_MS = 3 * 60_000;

export type JobRun = {
  /** ms epoch when the run's first stage was written */
  startedAt: number;
  /** true when the run reached a reply or error stage */
  ended: boolean;
  /** true when that ending was an error */
  failed?: boolean;
};

export type StallReport = {
  stalled: boolean;
  /** why it is stuck — null when it is not */
  reason: "hung" | "failing" | null;
  runs: number;
  unfinished: number;
  failures: number;
  /** how long the trouble has been going on, in minutes */
  sinceMin: number;
};

/**
 * Stalled when, over the recent window, either:
 *  - HUNG: at least MIN_STALLED_RUNS runs never reached an ending (older than
 *    GRACE_MS), the oldest has hung for STALL_AFTER_MS, and nothing finished in
 *    that stretch — one finished run proves the job still completes.
 *  - FAILING: at least MIN_STALLED_RUNS runs ended in an error, the oldest of
 *    them is STALL_AFTER_MS old, and nothing SUCCEEDED in that stretch.
 *
 * A run that ends with "nothing to send" counts as a success: it is a healthy
 * ending, and it means the job still works.
 */
export function decideStall(runs: JobRun[], now: number): StallReport {
  const unfinished = runs.filter((r) => !r.ended && now - r.startedAt > GRACE_MS);
  const failures = runs.filter((r) => r.ended && r.failed);
  const anyEndedRecently = runs.some((r) => r.ended && now - r.startedAt <= STALL_AFTER_MS);
  const anySucceededRecently = runs.some(
    (r) => r.ended && !r.failed && now - r.startedAt <= STALL_AFTER_MS
  );

  const oldest = (list: JobRun[]) => Math.min(...list.map((r) => r.startedAt));

  const hung =
    !anyEndedRecently &&
    unfinished.length >= MIN_STALLED_RUNS &&
    now - oldest(unfinished) >= STALL_AFTER_MS;

  const failing =
    !anySucceededRecently &&
    failures.length >= MIN_STALLED_RUNS &&
    now - oldest(failures) >= STALL_AFTER_MS;

  const reason: StallReport["reason"] = hung ? "hung" : failing ? "failing" : null;
  const trouble = hung ? unfinished : failing ? failures : [];
  return {
    stalled: !!reason,
    reason,
    runs: runs.length,
    unfinished: unfinished.length,
    failures: failures.length,
    sinceMin: trouble.length ? Math.round((now - oldest(trouble)) / 60_000) : 0,
  };
}
