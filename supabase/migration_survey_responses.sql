-- Survey responses from the LINE feature interest form (ฉบับสั้น / คู่มือเต็ม).
-- Run in Supabase SQL Editor once.

CREATE TABLE IF NOT EXISTS public.survey_responses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  survey_id TEXT NOT NULL DEFAULT 'line-short-v2',
  name TEXT,
  dept TEXT,
  role_title TEXT,
  note TEXT,
  star_id TEXT,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  comments JSONB NOT NULL DEFAULT '{}'::jsonb,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_responses_created
  ON public.survey_responses(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey
  ON public.survey_responses(survey_id, created_at DESC);
