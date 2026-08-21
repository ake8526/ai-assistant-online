-- Create table for storing full chat history for LLM fine-tuning dataset
CREATE TABLE IF NOT EXISTS public.chat_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id TEXT NOT NULL,           -- e.g. UPN or LINE user_id
    user_upn TEXT,                      -- UPN of the user (if authenticated/linked)
    channel TEXT NOT NULL DEFAULT 'line', -- 'line' | 'web' | 'system'
    role TEXT NOT NULL,                 -- 'user' | 'assistant' | 'system'
    content TEXT NOT NULL,              -- Text message
    metadata JSONB DEFAULT '{}'::jsonb, -- Extra data (e.g. intent, tokens, model used)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for fast lookups by session or user and export by time range
CREATE INDEX IF NOT EXISTS idx_chat_logs_session_time ON public.chat_logs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_logs_upn_time ON public.chat_logs(user_upn, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_logs_created_at ON public.chat_logs(created_at DESC);
