import { NextResponse } from "next/server";
import { nowLocal } from "@/lib/graph";

/** Temporary deploy probe — confirms morning-match logic on the live bundle. */
export const dynamic = "force-dynamic";

function hasMorningMeetingsHint(text: string): boolean {
  return (
    text.includes("\u0E40\u0E0A\u0E49\u0E32\u0E19\u0E35\u0E49") ||
    text.includes("\u0E14\u0E39\u0E1B\u0E23\u0E30\u0E0A\u0E38\u0E21\u0E40\u0E0A\u0E49\u0E32") ||
    text.includes("\u0E19\u0E31\u0E14\u0E40\u0E0A\u0E49\u0E32") ||
    text.includes("\u0E1B\u0E23\u0E30\u0E0A\u0E38\u0E21\u0E40\u0E0A\u0E49\u0E32") ||
    text.includes("\u0E15\u0E32\u0E23\u0E32\u0E07\u0E40\u0E0A\u0E49\u0E32")
  );
}

export async function GET() {
  const sample = "\u0E14\u0E39\u0E1B\u0E23\u0E30\u0E0A\u0E38\u0E21\u0E40\u0E0A\u0E49\u0E32\u0E19\u0E35\u0E49";
  return NextResponse.json({
    sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
    bangkokToday: nowLocal().date,
    sample,
    morningHint: hasMorningMeetingsHint(sample),
    ok: hasMorningMeetingsHint(sample),
  });
}
