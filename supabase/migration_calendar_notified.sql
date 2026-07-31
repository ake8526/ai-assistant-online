-- Run in Supabase SQL editor once.
-- Tracks calendar events already pushed to LINE as "นัดใหม่".

CREATE TABLE IF NOT EXISTS calendar_notified (
    owner_upn TEXT NOT NULL,
    event_id TEXT NOT NULL,
    subject TEXT,
    notified_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner_upn, event_id)
);

ALTER TABLE calendar_notified ENABLE ROW LEVEL SECURITY;
