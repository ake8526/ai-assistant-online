-- Add identity columns so we can show which Google/YouTube account is linked.
-- Safe to run repeatedly in Supabase SQL Editor.

ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS account_email TEXT;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS account_name TEXT;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS account_channel TEXT;
