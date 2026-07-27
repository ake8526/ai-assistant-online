import { NextResponse } from "next/server";
import { buildAuthUrl, isConfigured } from "@/lib/youtube";

// GET /api/oauth/google/start?upn=...  → redirect to Google consent (YouTube readonly)
export async function GET(req: Request) {
  const upn = (new URL(req.url).searchParams.get("upn") || "").toLowerCase().trim();
  if (!isConfigured()) {
    return NextResponse.json({ error: "ยังไม่ได้ตั้งค่า Google OAuth (GOOGLE_CLIENT_ID/SECRET/REDIRECT)" }, { status: 400 });
  }
  if (!upn) return NextResponse.json({ error: "upn required" }, { status: 400 });
  // state carries the upn so the callback knows who connected (pilot: plain base64)
  const state = Buffer.from(upn, "utf-8").toString("base64url");
  return NextResponse.redirect(buildAuthUrl(state));
}
