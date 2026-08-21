-- =====================================================================
--  Tech Brief Agent — Supabase setup
--  Run this in the Supabase SQL Editor (Dashboard → SQL).
-- =====================================================================

-- 1) Cross-day dedup: fingerprints of stories already sent.
create table if not exists public.sent_stories (
  fingerprint text primary key,
  title       text,
  url         text,
  sent_at     timestamptz not null default now()
);

create index if not exists sent_stories_sent_at_idx
  on public.sent_stories (sent_at desc);

-- 2) Public storage bucket for the daily infographic PNG.
--    (LINE fetches image messages from a public URL.)
insert into storage.buckets (id, name, public)
values ('tech-brief', 'tech-brief', true)
on conflict (id) do update set public = true;

-- Notes:
-- • The agent connects with the SERVICE ROLE key (server-side only, never ship
--   it to a client), so it bypasses RLS — no extra policies are required for
--   sent_stories. If you prefer RLS on, add policies for the service role.
-- • The bucket MUST stay public so LINE can load the image. The daily object is
--   overwritten (upsert) as brief-YYYY-MM-DD.png.

-- 3) OPTIONAL (only if PUBLISH_LATEST=1): a single-row table other systems read.
create table if not exists public.latest_brief (
  id         text primary key default 'latest',
  image_url  text,
  stories    jsonb,
  updated_at timestamptz not null default now()
);
