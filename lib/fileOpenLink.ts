import crypto from "crypto";

const APP_BASE = (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "");
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function linkSecret(): string {
  return process.env.FILE_LINK_SECRET || process.env.LINE_CHANNEL_SECRET || "dev-file-link";
}

export function signFileOpenToken(upn: string, fileId: string, expMs: number): string {
  const payload = `${upn}|${fileId}|${expMs}`;
  return crypto.createHmac("sha256", linkSecret()).update(payload).digest("base64url");
}

export function verifyFileOpenToken(upn: string, fileId: string, expMs: number, sig: string): boolean {
  if (!upn || !fileId || !expMs || !sig || Date.now() > expMs) return false;
  try {
    const expected = signFileOpenToken(upn, fileId, expMs);
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expected, "base64url");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Short redirect URL for LINE (avoids multi-line SharePoint links in chat). */
export function buildShortFileOpenUrl(upn: string, fileId: string): string {
  const exp = Date.now() + LINK_TTL_MS;
  const sig = signFileOpenToken(upn, fileId, exp);
  const u = Buffer.from(upn, "utf8").toString("base64url");
  const q = new URLSearchParams({
    u,
    id: fileId,
    e: String(exp),
    s: sig,
  });
  return `${APP_BASE}/api/file/open?${q.toString()}`;
}
