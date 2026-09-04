import { NextResponse } from "next/server";
import { assertConfigured } from "@/lib/supabaseServer";
import { insertSurveyResponse } from "@/lib/surveyResponses";

export const dynamic = "force-dynamic";

const ALLOWED_SURVEYS = new Set(["line-short-v2", "line-full-v2"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

type IdFromToken = {
  name: string;
  upn: string;
  email: string;
  dept: string;
  jobTitle: string;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const o = JSON.parse(json);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** ดึงตัวตนจาก Bearer — เรียก Graph ถ้าเป็น access token หรืออ่าน claim จาก JWT */
async function identityFromBearer(req: Request): Promise<IdFromToken | null> {
  const raw = req.headers.get("authorization") || "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m?.[1] || m[1].length < 40) return null;
  const token = m[1].trim();

  try {
    const r = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName,jobTitle,department",
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
    );
    if (r.ok) {
      const me = (await r.json()) as Record<string, string>;
      const upn = clip(me.userPrincipalName || me.mail, 120);
      const name = clip(me.displayName, 120);
      if (upn || name) {
        return {
          name: name || upn,
          upn,
          email: clip(me.mail || upn, 120),
          dept: clip(me.department, 120),
          jobTitle: clip(me.jobTitle, 120),
        };
      }
    }
  } catch {
    /* fall through to JWT claims */
  }

  const p = decodeJwtPayload(token);
  if (!p) return null;
  const upn = clip(p.preferred_username ?? p.upn ?? p.unique_name ?? p.email ?? p.sub, 120);
  const name = clip(p.name ?? p.given_name, 120);
  if (!upn && !name) return null;
  return {
    name: name || upn,
    upn,
    email: clip(p.email ?? p.preferred_username ?? upn, 120),
    dept: "",
    jobTitle: "",
  };
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
    const m365 = asObject((body as { m365?: unknown }).m365);
    const fromAuth = await identityFromBearer(req);

    const name =
      clip(fromAuth?.name, 120) ||
      clip(who.wName ?? (body as { name?: string }).name, 120) ||
      clip(m365.name, 120) ||
      null;
    const dept =
      clip(fromAuth?.dept, 120) ||
      clip(who.wDept ?? (body as { dept?: string }).dept, 120) ||
      clip(m365.dept, 120) ||
      null;
    const role_title =
      clip(fromAuth?.jobTitle, 120) ||
      clip(who.wRole ?? (body as { role?: string }).role, 120) ||
      clip(m365.jobTitle, 120) ||
      null;
    const upn =
      clip(fromAuth?.upn, 120) ||
      clip(who.wUpn ?? m365.upn, 120) ||
      null;
    const email =
      clip(fromAuth?.email, 120) ||
      clip(who.wEmail ?? m365.email, 120) ||
      null;

    const saved = await insertSurveyResponse({
      survey_id: surveyId,
      name,
      dept,
      role_title,
      note: clip(who.wNote ?? (body as { note?: string }).note, 2000) || null,
      star_id: clip((body as { starId?: string }).starId, 40) || null,
      answers: cleanAnswers,
      comments,
      meta: {
        ua: clip(req.headers.get("user-agent"), 240),
        labels: asObject((body as { labels?: unknown }).labels),
        kinds: asObject((body as { kinds?: unknown }).kinds),
        upn,
        email,
        fromAuth: !!fromAuth,
        m365: Object.keys(m365).length
          ? {
              name: clip(m365.name, 120) || null,
              email: clip(m365.email, 120) || null,
              upn: clip(m365.upn, 120) || null,
              dept: clip(m365.dept, 120) || null,
              jobTitle: clip(m365.jobTitle, 120) || null,
            }
          : null,
      },
    });

    return json({ ok: true, id: saved.id, createdAt: saved.created_at });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, { status: 500 });
  }
}
