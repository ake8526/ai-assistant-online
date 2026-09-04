/**
 * Survey form responses.
 *
 * Prefer the `survey_responses` table when it exists. If the migration was never
 * run (common in this project), fall back to the `settings` bucket — same
 * pattern as roles / blocked / seen-meetings.
 */
import { randomUUID } from "crypto";
import { admin } from "@/lib/supabaseServer";
import { allSettings, setSetting } from "@/lib/store";

const OWNER = "_survey";
const KEY_PREFIX = "resp_";

export type SurveyResponse = {
  id: string;
  survey_id: string;
  name: string | null;
  dept: string | null;
  role_title: string | null;
  note: string | null;
  star_id: string | null;
  answers: Record<string, number>;
  comments: Record<string, string>;
  meta: Record<string, unknown>;
  created_at: string;
};

export type SurveyInsert = {
  survey_id: string;
  name: string | null;
  dept: string | null;
  role_title: string | null;
  note: string | null;
  star_id: string | null;
  answers: Record<string, number>;
  comments: Record<string, string>;
  meta: Record<string, unknown>;
};

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "42P01" || /survey_responses/i.test(err.message || "");
}

async function insertViaSettings(row: SurveyInsert): Promise<SurveyResponse> {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  const full: SurveyResponse = { id, created_at, ...row };
  await setSetting(OWNER, `${KEY_PREFIX}${id}`, JSON.stringify(full));
  return full;
}

async function listViaSettings(surveyId: string | null, limit: number): Promise<SurveyResponse[]> {
  const all = await allSettings(OWNER);
  const rows: SurveyResponse[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    try {
      const parsed = JSON.parse(value) as SurveyResponse;
      if (!parsed?.id || !parsed?.answers) continue;
      if (surveyId && parsed.survey_id !== surveyId) continue;
      rows.push(parsed);
    } catch {
      /* skip bad rows */
    }
  }
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rows.slice(0, limit);
}

export async function insertSurveyResponse(row: SurveyInsert): Promise<SurveyResponse> {
  const { data, error } = await admin
    .from("survey_responses")
    .insert(row)
    .select("id,created_at,survey_id,name,dept,role_title,note,star_id,answers,comments,meta")
    .single();

  if (!error && data) {
    return {
      id: data.id,
      survey_id: data.survey_id,
      name: data.name,
      dept: data.dept,
      role_title: data.role_title,
      note: data.note,
      star_id: data.star_id,
      answers: (data.answers || {}) as Record<string, number>,
      comments: (data.comments || {}) as Record<string, string>,
      meta: (data.meta || {}) as Record<string, unknown>,
      created_at: data.created_at,
    };
  }

  if (isMissingTable(error)) {
    return insertViaSettings(row);
  }

  throw new Error(error?.message || "insert failed");
}

export async function listSurveyResponses(
  surveyId: string | null,
  limit = 100
): Promise<{ rows: SurveyResponse[]; total: number; storage: "table" | "settings" }> {
  let q = admin
    .from("survey_responses")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (surveyId) q = q.eq("survey_id", surveyId);

  const { data, error, count } = await q;

  if (!error) {
    return {
      rows: (data || []) as SurveyResponse[],
      total: count ?? (data || []).length,
      storage: "table",
    };
  }

  if (isMissingTable(error)) {
    const rows = await listViaSettings(surveyId, limit);
    return { rows, total: rows.length, storage: "settings" };
  }

  throw new Error(error.message);
}
