/**
 * Per-user latest-turn gate for the LINE webhook.
 *
 * Rapid taps/messages overwrite a shared pending token; after a short quiet
 * window only the latest token may run. While it runs, newer events wait (or
 * supersede). Reply/push helpers check AsyncLocalStorage and stay silent when
 * this turn is no longer current — so one mash → one reply across the bot.
 *
 * Also: when LINE batches many events in one webhook, keepLatestLineEvents()
 * drops all but the newest user action per user (sequential handling used to
 * answer every one).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getSetting, setSetting, deleteSetting } from "@/lib/store";

const PEND_KEY = "_line_turn";
const BUSY_KEY = "_line_busy";
const SETTLE_MS = 100;
const BUSY_WAIT_MS = 45_000;

/** Quiet window after the latest text before we answer (catches mash sends). */
export const LINE_DEBOUNCE_TEXT_MS = 900;
export const LINE_DEBOUNCE_POSTBACK_MS = 700;
export const LINE_DEBOUNCE_MEDIA_MS = 700;

type TurnCtx = { upn: string; token: string };

const als = new AsyncLocalStorage<TurnCtx>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ownerKey(upn: string): string {
  return upn.toLowerCase();
}

/** Minimal event shape for collapsing a webhook batch. */
export type LineEventLike = {
  type: string;
  timestamp?: number;
  source?: { userId?: string };
  message?: { type?: string };
};

function isUserActionEvent(ev: LineEventLike): boolean {
  if (ev.type === "postback") return true;
  if (ev.type === "message") {
    const t = ev.message?.type;
    return t === "text" || t === "image" || t === "location";
  }
  return false;
}

/**
 * LINE often delivers a mash as many events in one POST. Processing them
 * one-by-one defeats debounce (each is alone in its quiet window). Keep only
 * the latest text / postback / image / location per userId; leave follow etc.
 */
export function keepLatestLineEvents<T extends LineEventLike>(events: T[]): T[] {
  if (events.length <= 1) return events;

  const latestIdx = new Map<string, number>();
  events.forEach((ev, idx) => {
    const uid = ev.source?.userId;
    if (!uid || !isUserActionEvent(ev)) return;
    const prev = latestIdx.get(uid);
    if (prev === undefined) {
      latestIdx.set(uid, idx);
      return;
    }
    const prevEv = events[prev]!;
    const prevTs = typeof prevEv.timestamp === "number" ? prevEv.timestamp : prev;
    const ts = typeof ev.timestamp === "number" ? ev.timestamp : idx;
    if (ts >= prevTs) latestIdx.set(uid, idx);
  });

  const keepAction = new Set(latestIdx.values());
  return events.filter((ev, idx) => {
    if (!ev.source?.userId || !isUserActionEvent(ev)) return true;
    return keepAction.has(idx);
  });
}

/** Claim the latest user turn after debounce. null = superseded, stay silent. */
export async function beginLineTurn(upn: string, debounceMs: number): Promise<{ token: string } | null> {
  const owner = ownerKey(upn);
  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await setSetting(owner, PEND_KEY, token);
  if (debounceMs > 0) await sleep(debounceMs);

  if ((await getSetting(owner, PEND_KEY)) !== token) return null;
  await sleep(SETTLE_MS);
  if ((await getSetting(owner, PEND_KEY)) !== token) return null;

  const waitStart = Date.now();
  while (Date.now() - waitStart < BUSY_WAIT_MS) {
    if ((await getSetting(owner, PEND_KEY)) !== token) return null;
    const busy = await getSetting(owner, BUSY_KEY);
    if (!busy) break;
    await sleep(100);
  }
  if ((await getSetting(owner, PEND_KEY)) !== token) return null;

  await setSetting(owner, BUSY_KEY, token);
  return { token };
}

async function releaseLineTurn(upn: string, token: string): Promise<void> {
  const owner = ownerKey(upn);
  try {
    const busy = await getSetting(owner, BUSY_KEY);
    if (busy === token) await deleteSetting(owner, BUSY_KEY);
  } catch {
    /* ignore */
  }
}

/** Run work as this turn; releases busy lock when finished. */
export async function runLineTurn<T>(upn: string, token: string, fn: () => Promise<T>): Promise<T> {
  const owner = ownerKey(upn);
  try {
    return await als.run({ upn: owner, token }, fn);
  } finally {
    await releaseLineTurn(owner, token);
  }
}

/** true when there is no turn context (cron) or this turn is still the latest. */
export async function lineTurnAllowsSend(): Promise<boolean> {
  const ctx = als.getStore();
  if (!ctx) return true;
  try {
    return (await getSetting(ctx.upn, PEND_KEY)) === ctx.token;
  } catch {
    return true;
  }
}

/** Optional early abort inside long handlers. */
export async function isCurrentLineTurn(): Promise<boolean> {
  return lineTurnAllowsSend();
}
