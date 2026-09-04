import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { assertConfigured } from "@/lib/supabaseServer";
import { clearSurveyResponses, listSurveyResponses } from "@/lib/surveyResponses";

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

/** DELETE /api/survey/responses?survey=…&confirm=ล้างผลสำรวจ */
export async function DELETE(req: Request) {
  const gate = await guard(req, "survey.view");
  if (!gate.ok) return gate.response;

  try {
    assertConfigured();
    const url = new URL(req.url);
    const surveyId = (url.searchParams.get("survey") || "").trim() || null;
    const confirm = (url.searchParams.get("confirm") || "").trim();
    if (confirm !== "ล้างผลสำรวจ") {
      return NextResponse.json(
        { error: "ต้องส่ง confirm=ล้างผลสำรวจ เพื่อยืนยัน" },
        { status: 400 }
      );
    }

    const result = await clearSurveyResponses(surveyId);
    return NextResponse.json({ ok: true, ...result, by: gate.upn });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
