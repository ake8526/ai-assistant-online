import "dotenv/config";
const int = (name, def) => parseInt(process.env[name] ?? String(def), 10);

// AI providers we support. Auto-selected by which API key is present
// (or force one with AI_PROVIDER). Order = auto-select priority.
export const PROVIDER_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai:    "OPENAI_API_KEY",
  gemini:    "GEMINI_API_KEY",
  groq:      "GROQ_API_KEY",
  qwen:      "DASHSCOPE_API_KEY",
};

export const CONFIG = {
  // agent
  aiProvider: (process.env.AI_PROVIDER || "").toLowerCase(),  // "" = auto
  maxSearches: int("MAX_SEARCHES", 18),
  maxTokens: int("MAX_TOKENS", 8192),

  brief: {
    minStories: int("MIN_STORIES", 3),
    maxStories: int("MAX_STORIES", 12),
    recencyHours: int("RECENCY_HOURS", 24),
    tzLabel: process.env.TZ_LABEL || "Asia/Bangkok",
  },

  run: {
    hostImage: process.env.HOST_IMAGE !== "0",
    sendLine: process.env.SEND_LINE !== "0",
    publishLatest: process.env.PUBLISH_LATEST === "1",
  },

  line: {
    token: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    // "broadcast" = LINE OA → all followers (no target id needed) [default]
    // "push"      = to a specific user/group/room id (needs LINE_TARGET_ID)
    sendMode: (process.env.LINE_SEND_MODE || "broadcast").toLowerCase(),
    targetId: process.env.LINE_TARGET_ID,
    ownerId: process.env.LINE_OWNER_ID || null,
  },

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: process.env.SUPABASE_BUCKET || "tech-brief",
    dedupTable: process.env.SUPABASE_DEDUP_TABLE || "sent_stories",
    latestTable: process.env.SUPABASE_LATEST_TABLE || "latest_brief",
    dedupWindowDays: int("DEDUP_WINDOW_DAYS", 7),
  },

  dryRun: process.env.DRY_RUN === "1",
};

export function assertAgent() {
  const has = Object.values(PROVIDER_KEYS).some((k) => process.env[k]);
  if (!has)
    throw new Error(
      "No AI provider key set. Add at least one of: " +
        Object.values(PROVIDER_KEYS).join(", ")
    );
}
export function assertSupabase() {
  const m = [];
  if (!CONFIG.supabase.url) m.push("SUPABASE_URL");
  if (!CONFIG.supabase.serviceKey) m.push("SUPABASE_SERVICE_ROLE_KEY");
  if (m.length) throw new Error(`Missing Supabase env: ${m.join(", ")}`);
}
export function assertLine() {
  const m = [];
  if (!CONFIG.line.token) m.push("LINE_CHANNEL_ACCESS_TOKEN");
  if (CONFIG.line.sendMode === "push" && !CONFIG.line.targetId)
    m.push("LINE_TARGET_ID (push mode)");
  if (m.length) throw new Error(`Missing LINE env: ${m.join(", ")}`);
}
