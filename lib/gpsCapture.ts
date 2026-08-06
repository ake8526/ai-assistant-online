import crypto from "crypto";

function secret(): string {
  return (
    process.env.GPS_CAPTURE_SECRET ||
    process.env.LINE_CHANNEL_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "ktis-gps-capture-dev"
  );
}

export type GpsCapturePayload = {
  upn: string;
  category: "work" | "home";
  exp: number;
};

export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(
    /\/$/,
    ""
  );
}

export function makeGpsCaptureToken(upn: string, category: "work" | "home", ttlMs = 15 * 60 * 1000): string {
  const payload: GpsCapturePayload = { upn, category, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyGpsCaptureToken(token: string): GpsCapturePayload | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto.createHmac("sha256", secret()).update(body!).digest("base64url");
  try {
    const a = Buffer.from(sig!);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as GpsCapturePayload;
    if (!parsed?.upn || (parsed.category !== "work" && parsed.category !== "home")) return null;
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function gpsCapturePageUrl(upn: string, category: "work" | "home"): string {
  const t = makeGpsCaptureToken(upn, category);
  return `${appBaseUrl()}/set-gps?t=${encodeURIComponent(t)}&as=${category}`;
}
