// Pluggable LLM client with provider fallback.
// LLM_PROVIDER supports a comma-separated chain, e.g. "qwen,groq,gemini"
// (try first, fall back on failure). Always replies in Thai (primary) / English only.
import { trace } from "@/lib/trace";

const LANGUAGE_RULE =
  "\n\nกติกาภาษา: ตอบเป็นภาษาไทยเป็นหลักเสมอ ใช้อังกฤษเฉพาะศัพท์เทคนิค/ชื่อเฉพาะ ห้ามตอบภาษาอื่นเด็ดขาด";

type Provider = "qwen" | "groq" | "gemini";

/** Skip a provider briefly after 429 so the next LINE message hits a healthy one first. */
const rateLimitedUntil = new Map<Provider, number>();

function markRateLimited(provider: Provider, ms = 60_000) {
  rateLimitedUntil.set(provider, Date.now() + ms);
}

function isRateLimited(provider: Provider): boolean {
  const until = rateLimitedUntil.get(provider) || 0;
  if (Date.now() >= until) {
    rateLimitedUntil.delete(provider);
    return false;
  }
  return true;
}

function providerChain(fast = false): Provider[] {
  const raw = (process.env.LLM_PROVIDER || "qwen,groq,gemini").toLowerCase();
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean) as Provider[];
  const known: Provider[] = ["qwen", "groq", "gemini"];
  let chain = wanted.filter((p) => known.includes(p));
  if (!chain.length) chain = fast ? ["groq", "qwen", "gemini"] : ["qwen", "groq", "gemini"];
  // Latency-sensitive calls (e.g. intent parsing on every LINE message) prefer
  // groq: it classifies in ~0.5s vs ~5s for qwen. Quality-sensitive generation
  // keeps the configured order. Gemini is a solid mid/fallback.
  if (fast && chain.includes("groq")) chain = ["groq", ...chain.filter((p) => p !== "groq")];
  // Soft-rotate away from recently rate-limited providers
  const healthy = chain.filter((p) => !isRateLimited(p));
  const limited = chain.filter((p) => isRateLimited(p));
  return healthy.length ? [...healthy, ...limited] : chain;
}

function settings(provider: Provider): { baseUrl: string; key: string; model: string } | null {
  if (provider === "qwen") {
    const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || "";
    if (!key) return null;
    return {
      baseUrl: process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      key,
      model: process.env.QWEN_MODEL || "qwen3-max",
    };
  }
  if (provider === "gemini") {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
    if (!key) return null;
    return {
      // OpenAI-compatible endpoint (Google AI Studio / Gemini API)
      baseUrl:
        process.env.GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com/v1beta/openai",
      key,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    };
  }
  const key = process.env.GROQ_API_KEY || "";
  if (!key) return null;
  return {
    baseUrl: "https://api.groq.com/openai/v1",
    key,
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  };
}

class ProviderHttpError extends Error {
  constructor(
    public provider: Provider,
    public status: number,
    detail: string
  ) {
    super(`${provider} ${status}: ${detail.slice(0, 120)}`);
    this.name = "ProviderHttpError";
  }
}

async function callProvider(
  provider: Provider,
  system: string,
  user: string,
  opts?: { json?: boolean; temperature?: number; timeoutMs?: number; fast?: boolean }
): Promise<string> {
  const cfg = settings(provider);
  if (!cfg) throw new Error(`${provider} not configured`);

  // Hard timeout so a slow/hanging provider aborts and falls back instead of
  // blocking the whole request (LINE users were waiting ~5s+ on qwen).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 20000);
  let res: Response;
  try {
    const body: Record<string, unknown> = {
      model: cfg.model,
      temperature: opts?.temperature ?? 0.3,
      messages: [
        { role: "system", content: system + (opts?.json ? "" : LANGUAGE_RULE) },
        { role: "user", content: user },
      ],
    };
    if (opts?.json) body.response_format = { type: "json_object" };
    // Gemini 2.5 Flash can spend tokens on "thinking"; for fast intent JSON keep it light.
    if (provider === "gemini" && opts?.fast) {
      body.reasoning_effort = "none";
    }

    res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 240);
    if (res.status === 429) markRateLimited(provider);
    throw new ProviderHttpError(provider, res.status, text);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/** User-facing Thai message — never leak provider JSON / org ids. */
export function llmUserErrorMessage(err: unknown): string {
  const s = String(err || "");
  if (/All LLM providers failed|groq 429|qwen 429|gemini 429|rate limit.*(?:groq|qwen|gemini|llama|model)/i.test(s)) {
    return "ระบบตอบคำถามหนาแน่นชั่วคราว ลองใหม่อีกสักครู่ครับ";
  }
  if (/Graph\s*429|MailboxConcurrency|ApplicationThrottled|TooManyRequests/i.test(s)) {
    return "Microsoft 365 หนาแน่นชั่วคราว ลองใหม่อีกสักครู่ครับ";
  }
  if (/No LLM provider configured/i.test(s)) {
    return "ระบบ AI ยังไม่พร้อม ติดต่อแอดมินได้ครับ";
  }
  if (/need_calendar_consent|calendar consent|ไม่ได้รับอนุญาตปฏิทิน/i.test(s)) {
    return "ยังไม่ได้เชื่อมปฏิทิน Microsoft 365 — กดอนุญาตปฏิทินก่อนนะครับ";
  }
  return "เกิดข้อผิดพลาดชั่วคราว ลองใหม่อีกครั้งครับ";
}

export async function chat(
  system: string,
  user: string,
  opts?: { json?: boolean; temperature?: number; fast?: boolean; timeoutMs?: number }
): Promise<string> {
  const chain = providerChain(opts?.fast).filter((p) => settings(p));
  if (!chain.length) {
    throw new Error("No LLM provider configured (set QWEN_API_KEY, GROQ_API_KEY, and/or GEMINI_API_KEY)");
  }

  const stage = opts?.json ? "parse" : "compose";
  const errors: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const cfg = settings(provider)!;
    try {
      // Monitor Agent Room: show which API key/provider is actively calling.
      trace(stage, `★ AI:${provider.toUpperCase()} · ${cfg.model}`, "start");
      const out = await callProvider(provider, system, user, opts);
      if (opts?.json) {
        trace("parse", `★ AI:${provider.toUpperCase()} · ${cfg.model} ✓`);
      } else {
        trace("compose", `★ AI:${provider.toUpperCase()} · ${cfg.model} · เขียนคำตอบ`);
      }
      return out;
    } catch (e) {
      const short =
        e instanceof ProviderHttpError
          ? `${e.provider} ${e.status}`
          : String(e).slice(0, 120);
      errors.push(short);
      trace(stage, `★ AI:${provider.toUpperCase()} · ${cfg.model} ✗ (${short})`, "error");
      if (i + 1 < chain.length) {
        console.warn(`[llm] ${provider} failed; trying ${chain[i + 1]} next — ${short}`);
        trace(stage, `★ AI:fallback → ${chain[i + 1]!.toUpperCase()}`, "start");
      }
    }
  }
  throw new Error(`All LLM providers failed — ${errors.join(" | ")}`);
}

/** Safe (no secrets) LLM status for /monitor — which keys are configured + chain order. */
export function llmMonitorInfo(): {
  chain: string[];
  ready: { id: string; model: string; keyEnv: string }[];
} {
  const known: Provider[] = ["qwen", "groq", "gemini"];
  const raw = (process.env.LLM_PROVIDER || "qwen,groq,gemini").toLowerCase();
  const chain = raw.split(",").map((s) => s.trim()).filter((p) => known.includes(p as Provider));
  const order = chain.length ? chain : known;
  const keyEnv: Record<Provider, string> = {
    qwen: process.env.QWEN_API_KEY ? "QWEN_API_KEY" : process.env.DASHSCOPE_API_KEY ? "DASHSCOPE_API_KEY" : "QWEN_API_KEY",
    groq: "GROQ_API_KEY",
    gemini: process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : "GEMINI_API_KEY",
  };
  const ready = (order as Provider[])
    .map((id) => {
      const s = settings(id);
      if (!s) return null;
      return { id, model: s.model, keyEnv: keyEnv[id] };
    })
    .filter(Boolean) as { id: string; model: string; keyEnv: string }[];
  return { chain: order, ready };
}
