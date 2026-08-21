// Pluggable LLM client with provider fallback.
// LLM_PROVIDER supports a comma-separated chain, e.g. "qwen,groq,gemini"
// (try first, fall back on failure). Always replies in Thai (primary) / English only.
import { trace, type TraceStep } from "@/lib/trace";

const LANGUAGE_RULE =
  "\n\nกติกาภาษา: ตอบเป็นภาษาไทยเป็นหลักเสมอ ใช้อังกฤษเฉพาะศัพท์เทคนิค/ชื่อเฉพาะ ห้ามตอบภาษาอื่นเด็ดขาด";

/** Always append Thai rule — including JSON mode (digest headlines/points). */
function withLanguageRule(system: string): string {
  return system.includes("กติกาภาษา:") ? system : system + LANGUAGE_RULE;
}

type Provider = "qwen" | "groq" | "gemini";

/** Skip a provider briefly after 429 so the next LINE message hits a healthy one first. */
const rateLimitedUntil = new Map<Provider, number>();

function markRateLimited(provider: Provider, ms = 45_000) {
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

/** Groq model chain — first that answers wins. Update when Groq retires a model.
 *  Both replacements Groq recommended when it retired llama-3.3-70b-versatile. */
const GROQ_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "openai/gpt-oss-20b"];

/** Latency-sensitive calls (intent parsing) — smaller model, same JSON quality. */
const GROQ_FAST_MODEL = "qwen/qwen3.6-27b";

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
    // llama-3.3-70b-versatile was decommissioned on 2026-08-16 (Groq notice).
    // Replacement per that notice; override with GROQ_MODEL when Groq renames again.
    model: process.env.GROQ_MODEL || GROQ_MODELS[0],
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

  const models =
    provider === "gemini"
      ? Array.from(
          new Set(
            [
              cfg.model,
              process.env.GEMINI_MODEL_FALLBACK || "",
              "gemini-2.0-flash",
              "gemini-flash-latest",
              "gemini-2.5-flash",
            ].filter(Boolean)
          )
        )
      : provider === "groq"
        ? Array.from(
            new Set(
              [
                // Intent parsing runs on every LINE message, so the fast path takes a
                // smaller model (~0.6s vs ~1.0s for the 120B) — quality work keeps cfg.model.
                opts?.fast ? process.env.GROQ_MODEL_FAST || GROQ_FAST_MODEL : "",
                cfg.model,
                process.env.GROQ_MODEL_FALLBACK || "",
                ...GROQ_MODELS,
              ].filter(Boolean)
            )
          )
        : [cfg.model];

  let lastErr: ProviderHttpError | null = null;
  for (const model of models) {
    // Hard timeout so a slow/hanging provider aborts and falls back instead of
    // blocking the whole request (LINE users were waiting ~5s+ on qwen).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 20000);
    let res: Response;
    try {
      const body: Record<string, unknown> = {
        model,
        temperature: opts?.temperature ?? 0.3,
        messages: [
          { role: "system", content: withLanguageRule(system) },
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
      lastErr = new ProviderHttpError(provider, res.status, text);
      // Model gone / renamed / decommissioned → try the next alias before failing
      // the whole provider (Groq retired llama-3.3-70b-versatile on 2026-08-16).
      const modelGone =
        res.status === 404 ||
        /not found|no longer available|decommission|deprecat|does not exist|model_not_found/i.test(text);
      if ((provider === "gemini" || provider === "groq") && modelGone) {
        console.warn(`[llm] ${provider} model ${model} → ${res.status}; trying next alias`);
        continue;
      }
      throw lastErr;
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
  throw lastErr || new Error(`${provider} failed`);
}

/** User-facing Thai message — never leak provider JSON / org ids. */
export function llmUserErrorMessage(err: unknown): string {
  const s = String(err || "");
  if (/All LLM providers failed|groq 429|qwen 429|gemini 429|rate limit.*(?:groq|qwen|gemini|llama|model)/i.test(s)) {
    return "ระบบ AI ติดขัดชั่วคราว — ลองกดเมนูหรือพิมพ์คำสั่งหลักอีกครั้งได้ครับ";
  }
  if (/Graph\s*429|MailboxConcurrency|ApplicationThrottled|TooManyRequests/i.test(s)) {
    return "Microsoft 365 ช้าชั่วคราว — ระบบจะลองใหม่ให้อัตโนมัติ หรือพิมพ์คำสั่งเดิมอีกครั้งครับ";
  }
  if (/No LLM provider configured/i.test(s)) {
    return "ระบบ AI ยังไม่พร้อม ติดต่อแอดมินได้ครับ";
  }
  if (/need_calendar_consent|calendar consent|ไม่ได้รับอนุญาตปฏิทิน/i.test(s)) {
    return "ยังไม่ได้เชื่อมปฏิทิน Microsoft 365 — กดอนุญาตปฏิทินก่อนนะครับ";
  }
  return "เกิดข้อผิดพลาดชั่วคราว — พิมพ์คำสั่งเดิมอีกครั้ง หรือกดเมนูด้านล่างได้ครับ";
}

export async function chat(
  system: string,
  user: string,
  opts?: {
    json?: boolean;
    temperature?: number;
    fast?: boolean;
    timeoutMs?: number;
    /** Force this provider first (others remain as fallback). */
    prefer?: Provider;
    /** Use only this provider — no fallback (for mandated summary models). */
    only?: Provider;
    /** Override pipeline stage for /monitor (e.g. news picker → fetch). */
    traceStep?: TraceStep;
    /** Prefix for monitor labels — use "📰 …" for the news room. */
    tracePrefix?: string;
  }
): Promise<string> {
  let chain: Provider[];
  if (opts?.only) {
    if (!settings(opts.only)) {
      throw new Error(`${opts.only} not configured (required for this summary task)`);
    }
    chain = [opts.only];
  } else {
    chain = providerChain(opts?.fast).filter((p) => settings(p));
    if (opts?.prefer && settings(opts.prefer)) {
      // Prefer healthy provider; if preferred is mid-cooldown, put it last.
      if (!isRateLimited(opts.prefer)) {
        chain = [opts.prefer, ...chain.filter((p) => p !== opts.prefer)];
      } else {
        chain = [...chain.filter((p) => p !== opts.prefer), opts.prefer];
      }
    }
  }
  if (!chain.length) {
    throw new Error("No LLM provider configured (set QWEN_API_KEY, GROQ_API_KEY, and/or GEMINI_API_KEY)");
  }
  // Try healthy providers first; still attempt cooling ones only after those fail.
  const healthy = chain.filter((p) => !isRateLimited(p));
  const cooling = chain.filter((p) => isRateLimited(p));
  chain = healthy.length ? [...healthy, ...cooling] : chain;

  const stage: TraceStep = opts?.traceStep ?? (opts?.json ? "parse" : "compose");
  const pfx = opts?.tracePrefix ? `${opts.tracePrefix} · ` : "";
  const errors: string[] = [];

  async function tryChain(providers: Provider[]): Promise<string | null> {
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      const cfg = settings(provider);
      if (!cfg) continue;
      try {
        trace(stage, `${pfx}★ AI:${provider.toUpperCase()} · ${cfg.model}`, "start");
        const out = await callProvider(provider, system, user, opts);
        if (opts?.json) {
          trace(stage, `${pfx}★ AI:${provider.toUpperCase()} · ${cfg.model} ✓`);
        } else {
          trace(stage, `${pfx}★ AI:${provider.toUpperCase()} · ${cfg.model} · เขียนคำตอบ`);
        }
        return out;
      } catch (e) {
        const short =
          e instanceof ProviderHttpError
            ? `${e.provider} ${e.status}`
            : String(e).slice(0, 120);
        errors.push(short);
        trace(stage, `${pfx}★ AI:${provider.toUpperCase()} · ${cfg.model} ✗ (${short})`, "error");
        if (i + 1 < providers.length) {
          console.warn(`[llm] ${provider} failed; trying ${providers[i + 1]} next — ${short}`);
          trace(stage, `${pfx}★ AI:fallback → ${providers[i + 1]!.toUpperCase()}`, "start");
        }
      }
    }
    return null;
  }

  const first = await tryChain(chain);
  if (first != null) return first;

  // Last resort: brief pause then retry cooling providers (don't strand the user on LINE).
  await new Promise((r) => setTimeout(r, 1200));
  for (const p of chain) rateLimitedUntil.delete(p);
  const retry = await tryChain(chain);
  if (retry != null) return retry;

  throw new Error(`All LLM providers failed — ${errors.join(" | ")}`);
}

/** News + meeting summaries must use Gemini (no Qwen/Groq fallback). */
export async function summaryChat(
  system: string,
  user: string,
  opts?: Omit<NonNullable<Parameters<typeof chat>[2]>, "only" | "prefer">
): Promise<string> {
  return chat(system, user, { ...opts, only: "gemini" });
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
