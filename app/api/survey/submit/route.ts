import { NextResponse } from "next/server";
import { assertConfigured } from "@/lib/supabaseServer";
import { insertSurveyResponse } from "@/lib/surveyResponses";

export const dynamic = "force-dynamic";

const ALLOWED_SURVEYS = new Set(["line-short-v2", "line-full-v2"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, init?: { status?: number }) {
  return NextResponse.json(data, { status: init?.status, headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function clip(s: unknown, max: number): string {
  return String(s ?? "")
    .trim()
    .slice(0, max);
}

function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

/** POST /api/survey/submit — public endpoint for the HTML survey form */
export async function POST(req: Request) {
  try {
    assertConfigured();
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ error: "invalid body" }, { status: 400 });
    }

    // Honeypot — bots fill this; real form leaves it empty
    if (clip((body as { website?: string }).website, 40)) {
      return json({ ok: true });
    }

    const surveyId = clip((body as { surveyId?: string }).surveyId, 40) || "line-short-v2";
    if (!ALLOWED_SURVEYS.has(surveyId)) {
      return json({ error: "unknown survey" }, { status: 400 });
    }

    const answers = asObject((body as { answers?: unknown }).answers);
    const answerKeys = Object.keys(answers);
    if (!answerKeys.length) {
      return json({ error: "ยังไม่มีคำตอบให้ส่ง" }, { status: 400 });
    }
    if (answerKeys.length > 80) {
      return json({ error: "too many answers" }, { status: 400 });
    }

    const cleanAnswers: Record<string, number> = {};
    for (const [k, v] of Object.entries(answers)) {
      const n = typeof v === "number" ? v : parseInt(String(v), 10);
      if (!Number.isFinite(n) || n < 0 || n > 5) continue;
      cleanAnswers[clip(k, 40)] = n;
    }
    if (!Object.keys(cleanAnswers).length) {
      return json({ error: "ยังไม่มีคำตอบให้ส่ง" }, { status: 400 });
    }

    const commentsRaw = asObject((body as { comments?: unknown }).comments);
    const comments: Record<string, string> = {};
    for (const [k, v] of Object.entries(commentsRaw)) {
      const t = clip(v, 800);
      if (t) comments[clip(k, 40)] = t;
    }

    const who = asObject((body as { who?: unknown }).who);
    const saved = await insertSurveyResponse({
      survey_id: surveyId,
      name: clip(who.wName ?? (body as { name?: string }).name, 120) || null,
      dept: clip(who.wDept ?? (body as { dept?: string }).dept, 120) || null,
      role_title: clip(who.wRole ?? (body as { role?: string }).role, 120) || null,
      note: clip(who.wNote ?? (body as { note?: string }).note, 2000) || null,
      star_id: clip((body as { starId?: string }).starId, 40) || null,
      answers: cleanAnswers,
      comments,
      meta: {
        ua: clip(req.headers.get("user-agent"), 240),
        labels: asObject((body as { labels?: unknown }).labels),
        kinds: asObject((body as { kinds?: unknown }).kinds),
      },
    });

    return json({ ok: true, id: saved.id, createdAt: saved.created_at });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
