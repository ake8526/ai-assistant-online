// Kick a long-running LINE digest on /api/digest/line-now (maxDuration=300).
// Webhook itself may be capped lower; self-fetch + one-time job token avoids
// relying only on CRON_SECRET / Deployment Protection.
import { randomUUID } from "crypto";
import { after } from "next/server";
import { waitUntil } from "@vercel/functions";
import { deleteSetting, getSetting, setSetting } from "@/lib/store";

const JOB_KEY = "line_digest_kick";
const CLAIM_KEY = "line_digest_claim";

export type DigestKickPayload = { token: string; ts: number };

export function digestKickSettingKey(): string {
  return JOB_KEY;
}

/** Only one worker should push the result (cron vs duplicate kicks). */
export async function claimDigestPush(upn: string): Promise<boolean> {
  const id = randomUUID();
  const prev = await getSetting(upn, CLAIM_KEY);
  if (prev) {
    try {
      const p = JSON.parse(prev) as { id?: string; ts?: number };
      // Short TTL: if the winner died mid-flight, another worker can take over.
      if (p.ts && Date.now() - p.ts < 90_000) return false;
    } catch {
      /* take over stale */
    }
  }
  await setSetting(upn, CLAIM_KEY, JSON.stringify({ id, ts: Date.now() }));
  await new Promise((r) => setTimeout(r, 40));
  const cur = await getSetting(upn, CLAIM_KEY);
  try {
    return (JSON.parse(cur || "{}") as { id?: string }).id === id;
  } catch {
    return false;
  }
}

export async function clearDigestClaim(upn: string): Promise<void> {
  try {
    await deleteSetting(upn, CLAIM_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Start line-now in a separate invocation.
 * Throws on early HTTP failure (auth / protection) so caller can finish locally.
 * Resolves once the job is accepted (still running after ~8s) or finished quickly.
 */
export async function kickLineDigest(upn: string): Promise<void> {
  const token = randomUUID();
  const payload: DigestKickPayload = { token, ts: Date.now() };
  await setSetting(upn, JOB_KEY, JSON.stringify(payload));

  const base = (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(
    /\/$/,
    ""
  );
  const secret = process.env.CRON_SECRET || "";
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
  const url =
    `${base}/api/digest/line-now?upn=${encodeURIComponent(upn)}` +
    `&job=${encodeURIComponent(token)}` +
    (secret ? `&key=${encodeURIComponent(secret)}` : "");

  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (secret) headers["x-cron-secret"] = secret;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;

  const started = fetch(url, { method: "POST", headers, cache: "no-store" });

  type Early = { kind: "res"; r: Response } | { kind: "timeout" };
  const early: Early = await Promise.race([
    started.then((r) => ({ kind: "res" as const, r })),
    new Promise<Early>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 1_500)),
  ]);

  if (early.kind === "res") {
    const body = await early.r.text().catch(() => "");
    console.warn("[kickLineDigest]", early.r.status, body.slice(0, 160));
    if (!early.r.ok) {
      throw new Error(`line-now ${early.r.status}: ${body.slice(0, 80)}`);
    }
    return;
  }

  // Still running after 1.5s ⇒ request was accepted; keep the connection alive in background.
  const background = started
    .then(async (r) => {
      const body = await r.text().catch(() => "");
      console.warn("[kickLineDigest late]", r.status, body.slice(0, 160));
    })
    .catch((e) => {
      console.warn("[kickLineDigest late]", String(e).slice(0, 200));
    });

  try {
    waitUntil(background);
  } catch {
    /* non-Vercel */
  }
  after(async () => {
    try {
      await background;
    } catch {
      /* logged above */
    }
  });
}
