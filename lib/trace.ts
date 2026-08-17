// Agent activity tracing — records the pipeline STAGES of one request so the
// /monitor page can visualise "the AI at work" in real time.
//
// Design goals:
//  - Zero signature churn: uses AsyncLocalStorage so any function running inside
//    a traced request can call trace() without threading a trace id through.
//  - Never breaks the request: every DB write is fire-and-forget + swallowed.
//  - Privacy: STAGES ONLY. Labels must not carry user message content — keep
//    them to intent names, resource names, provider names, counts.
//
// Toggle off with AGENT_TRACING=false.
import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { admin } from "@/lib/supabaseServer";

export type TraceStep = "receive" | "parse" | "fetch" | "compose" | "reply" | "error";
/** "skip" = the job finished with nothing to send (no new appointment, no
 *  meeting to summarise). It is a healthy ending, not a failure — without it
 *  /monitor/log cannot tell a quiet run apart from one that died mid-flight. */
export type TraceStatus = "start" | "done" | "error" | "skip";

type TraceCtx = {
  traceId: string;
  upn?: string;
  channel: string;
  seq: number;
  t0: number;
  pending: PromiseLike<unknown>[];
  /** Background work (e.g. after() attach) — skip fetch noise on /monitor */
  muted?: boolean;
};

const als = new AsyncLocalStorage<TraceCtx>();

function enabled(): boolean {
  if ((process.env.AGENT_TRACING || "true").toLowerCase() === "false") return false;
  // No Supabase config → silently no-op (e.g. local build without env).
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

/**
 * Run `fn` inside a fresh trace context. All trace() calls made anywhere in the
 * async call tree of `fn` attach to the same trace_id. Awaits any in-flight
 * inserts before resolving so serverless freeze never drops events.
 */
export async function runWithTrace<T>(
  meta: { upn?: string; channel: string },
  fn: () => Promise<T>
): Promise<T> {
  if (!enabled()) return fn();
  const ctx: TraceCtx = {
    traceId: randomUUID(),
    upn: meta.upn,
    channel: meta.channel,
    seq: 0,
    t0: Date.now(),
    pending: [],
  };
  try {
    return await als.run(ctx, fn);
  } finally {
    if (ctx.pending.length) {
      try {
        await Promise.allSettled(ctx.pending);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Set/refine the acting user once it's known (e.g. after LINE→UPN lookup). */
export function setTraceUser(upn: string): void {
  const ctx = als.getStore();
  if (ctx) ctx.upn = upn;
}

export function currentTraceId(): string | null {
  return als.getStore()?.traceId ?? null;
}

/** Stop tracing further stages (background after() work). */
export function muteTrace(): void {
  const ctx = als.getStore();
  if (ctx) ctx.muted = true;
}

/**
 * Record one pipeline stage. No-op outside a traced request. `label` must be
 * non-PII (stage/intent/resource names only — never message text).
 */
export function trace(step: TraceStep, label?: string, status: TraceStatus = "done"): void {
  const ctx = als.getStore();
  if (!ctx || ctx.muted) return;
  const seq = ctx.seq++;
  const row = {
    trace_id: ctx.traceId,
    upn: ctx.upn || null,
    channel: ctx.channel,
    step,
    label: label ? label.slice(0, 180) : null,
    status,
    seq,
    ms: Date.now() - ctx.t0,
  };
  try {
    const p = admin
      .from("agent_traces")
      .insert(row)
      .then(
        () => {},
        () => {}
      );
    ctx.pending.push(p);
  } catch {
    /* never throw from tracing */
  }
}
