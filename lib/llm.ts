// Pluggable LLM client with provider fallback.
// LLM_PROVIDER supports a comma-separated chain, e.g. "qwen,groq"
// (try first, fall back on failure). Always replies in Thai (primary) / English only.
import { trace } from "@/lib/trace";

const LANGUAGE_RULE =
  "\n\nกติกาภาษา: ตอบเป็นภาษาไทยเป็นหลักเสมอ ใช้อังกฤษเฉพาะศัพท์เทคนิค/ชื่อเฉพาะ ห้ามตอบภาษาอื่นเด็ดขาด";

type Provider = "qwen" | "groq";

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
  const raw = (process.env.LLM_PROVIDER || "qwen,groq").toLowerCase();
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean) as Provider[];
  const known: Provider[] = ["qwen", "groq"];
  let chain = wanted.filter((p) => known.includes(p));
  if (!chain.length) chain = fast ? ["groq", "qwen"] : ["qwen", "groq"];
  // Latency-sensitive calls (e.g. intent parsing on every LINE message) prefer
  // groq: it classifies in ~0.5s vs ~5s for qwen. Quality-sensitive generation
  // keeps the configured order.
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
  opts?: { json?: boolean; temperature?: number; timeoutMs?: number }
): Promise<string> {
  const cfg = settings(provider);
  if (!cfg) throw new Error(`${provider} not configured`);

  // Hard timeout so a slow/hanging provider aborts and falls back instead of
  // blocking the whole request (LINE users were waiting ~5s+ on qwen).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        temperature: opts?.temperature ?? 0.3,
        ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system + (opts?.json ? "" : LANGUAGE_RULE) },
          { role: "user", content: user },
        ],
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 240);
    if (res.status === 429) markRateLimited(provider);
    throw new ProviderHttpError(provider, res.status, body);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/** User-facing Thai message — never leak provider JSON / org ids. */
export function llmUserErrorMessage(err: unknown): string {
  const s = String(err || "");
  if (/429|rate limit|All LLM providers failed/i.test(s)) {
    return "ระบบตอบคำถามหนาแน่นชั่วคราว ลองใหม่อีกสักครู่ครับ";
  }
  if (/No LLM provider configured/i.test(s)) {
    return "ระบบ AI ยังไม่พร้อม ติดต่อแอดมินได้ครับ";
  }
  return "เกิดข้อผิดพลาดชั่วคราว ลองใหม่อีกครั้งครับ";
}

export async function chat(
  system: string,
  user: string,
  opts?: { json?: boolean; temperature?: number; fast?: boolean; timeoutMs?: number }
): Promise<string> {
  const chain = providerChain(opts?.fast).filter((p) => settings(p));
  if (!chain.length) throw new Error("No LLM provider configured (set QWEN_API_KEY and/or GROQ_API_KEY)");

  const errors: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    try {
      const out = await callProvider(provider, system, user, opts);
      // Monitor: non-JSON calls are natural-language generation → "compose" stage.
      // JSON calls (intent parsing / extraction) are traced explicitly at their
      // call sites, so skip them here to avoid double-counting.
      if (!opts?.json) trace("compose", `เขียนคำตอบ (${provider})`);
      return out;
    } catch (e) {
      const short =
        e instanceof ProviderHttpError
          ? `${e.provider} ${e.status}`
          : String(e).slice(0, 120);
      errors.push(short);
      if (i + 1 < chain.length) {
        console.warn(`[llm] ${provider} failed; trying ${chain[i + 1]} next — ${short}`);
      }
    }
  }
  throw new Error(`All LLM providers failed — ${errors.join(" | ")}`);
}
