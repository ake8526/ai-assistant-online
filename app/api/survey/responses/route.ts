import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

/** GET /api/survey/responses — admin view of submitted survey answers */
export async function GET(req: Request) {
  const gate = await guard(req, "survey.view");
  if (!gate.ok) return gate.response;

  try {
    assertConfigured();
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;
    const surveyId = (url.searchParams.get("survey") || "").trim();

    let query = admin
      .from("survey_responses")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    if (surveyId) query = query.eq("survey_id", surveyId);
    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) {
      if (error.code === "42P01" || /survey_responses/i.test(error.message)) {
        return NextResponse.json({
          rows: [],
          total: 0,
          note: "ตาราง survey_responses ยังไม่ถูกสร้าง — รันไฟล์ supabase/migration_survey_responses.sql ใน Supabase SQL Editor",
        });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ rows: data || [], total: count ?? 0 });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
