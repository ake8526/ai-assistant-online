import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { assertConfigured } from "@/lib/supabaseServer";
import { listSurveyResponses } from "@/lib/surveyResponses";

export const dynamic = "force-dynamic";

/** GET /api/survey/responses — admin view of submitted survey answers */
export async function GET(req: Request) {
  const gate = await guard(req, "survey.view");
  if (!gate.ok) return gate.response;

  try {
    assertConfigured();
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
    const surveyId = (url.searchParams.get("survey") || "").trim() || null;

    const { rows, total, storage } = await listSurveyResponses(surveyId, offset + limit);
    const page = rows.slice(offset, offset + limit);

    return NextResponse.json({
      rows: page,
      total,
      storage,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
