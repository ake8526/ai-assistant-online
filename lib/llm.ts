// Pluggable LLM client with provider fallback.
// LLM_PROVIDER supports a comma-separated chain, e.g. "groq,gemini,ark"
// (try first, fall back on failure). Always replies in Thai (primary) / English only.
import { trace, type TraceStep } from "@/lib/trace";
import { recordUsage } from "@/lib/llmUsage";

const LANGUAGE_RULE =
  "\n\nกติกาภาษา: ตอบเป็นภาษาไทยเป็นหลักเสมอ ใช้อังกฤษเฉพาะศัพท์เทคนิค/ชื่อเฉพาะ ห้ามตอบภาษาอื่นเด็ดขาด";

/** Always append Thai rule — including JSON mode (digest headlines/points). */
function withLanguageRule(system: string): string {
  return system.includes("กติกาภาษา:") ? system : system + LANGUAGE_RULE;
}

type Provider = "qwen" | "groq" | "gemini" | "ark";

/** Skip a provider briefly after 429 so the next LINE message hits a healthy one first. */
const rateLimitedUntil = new Map<Provider, number>();

/**
 * พักผู้ให้บริการที่กำลังมีปัญหา คนที่สุขภาพดีจะได้ตอบก่อน
 *
 * เดิมใช้กับ 429 อย่างเดียว ซึ่งไม่พอ: 4 ก.ย. 2569 โควตาฟรีของ Qwen หมด คืน 403
 * ทุกครั้ง แต่ Qwen เป็นตัวแรกในลูกโซ่ ทุกคำสั่งจึงยิงทิ้งหนึ่งรอบก่อนตกไปตัวถัดไป
 * ระบบไม่พังเพราะมีตัวสำรอง แต่ช้าลงโดยไม่จำเป็น และเงียบจนกว่าจะไปอ่าน log เอง
 */
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
  const raw = (process.env.LLM_PROVIDER || "groq,gemini").toLowerCase();
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean) as Provider[];
  const known: Provider[] = ["qwen", "groq", "gemini", "ark"];
  let chain = wanted.filter((p) => known.includes(p));
  // ค่าตั้งต้นไม่มี qwen แล้ว โควตาฟรีหมดตั้งแต่ ก.ย. 2569 (403 AllocationQuota.FreeTierOnly)
  if (!chain.length) chain = ["groq", "gemini"];
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

/**
 * รุ่นบน BytePlus Ark เรียงตามลำดับที่อยากให้เป็นคนตอบ
 *
 * ทั้งสามรองรับ response_format JSON ซึ่งระบบนี้ใช้ทั้งตอนแยกเจตนาและตอนสรุป
 * (deepseek กับ gpt-oss บน Ark ไม่รองรับ json_object จึงไม่เอามาเป็นตัวหลัก)
 * เปลี่ยนได้ที่ env ARK_MODEL / ARK_MODEL_FALLBACK โดยไม่ต้องแก้โค้ด
 */
const ARK_MODELS = ["seed-2-0-lite-260428", "seed-2-0-mini-260428", "glm-5-2-260617"];

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
  if (provider === "ark") {
    /* BytePlus ModelArk (ภูมิภาค ap-southeast) พูดภาษา OpenAI ได้ตรง ๆ
       ข้อควรรู้: ทุกรุ่นต้องกดเปิดใช้ใน Ark Console ก่อน ไม่งั้นคืน 404 ModelNotOpen
       ทั้งที่คีย์ถูก — ลิสต์สำรองด้านล่างจึงมีไว้เผื่อเปิดมาไม่ครบทุกรุ่น */
    const key = process.env.ARK_API_KEY || "";
    if (!key) return null;
    return {
      baseUrl: process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3",
      key,
      model: process.env.ARK_MODEL || ARK_MODELS[0],
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
      model: liveGeminiModel(process.env.GEMINI_MODEL),
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

/**
 * ชื่อรุ่น Gemini ที่ Google ปลดไปแล้ว → รุ่นที่ใช้แทน
 *
 * ตรวจกับคีย์จริง 2 ก.ย. 2026: gemini-2.5-flash และ gemini-2.0-flash ตอบ 404
 * ("no longer available to new users") ส่วน gemini-flash-latest กับ
 * gemini-3.6-flash ใช้ได้ ระบบยังทำงานอยู่เพราะมีลิสต์สำรอง แต่เสียเวลายิงทิ้ง
 * สองครั้งทุกครั้งที่สรุปประชุม และ env บน Vercel ยังตั้งชื่อเก่าไว้
 *
 * แปลงชื่อให้ที่โค้ดเลย ไม่ต้องรอใครไปแก้ env ก่อน — ค่าที่ตั้งไว้ผิดรุ่นไม่ควร
 * ทำให้ระบบช้าลงเงียบ ๆ
 */
const GEMINI_RETIRED: Record<string, string> = {
  "gemini-2.0-flash": "gemini-flash-latest",
  "gemini-2.5-flash": "gemini-flash-latest",
  "gemini-1.5-flash": "gemini-flash-latest",
  "gemini-1.5-pro": "gemini-flash-latest",
};

function liveGeminiModel(name?: string): string {
  const m = (name || "").trim();
  if (!m) return "gemini-flash-latest";
  return GEMINI_RETIRED[m] || m;
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
  opts?: { json?: boolean; temperature?: number; timeoutMs?: number; fast?: boolean; task?: string }
): Promise<string> {
  const cfg = settings(provider);
  if (!cfg) throw new Error(`${provider} not configured`);

  const models =
    provider === "ark"
      ? Array.from(new Set([cfg.model, process.env.ARK_MODEL_FALLBACK || "", ...ARK_MODELS].filter(Boolean)))
      : provider === "gemini"
      ? Array.from(
          new Set(
            [
              cfg.model,
              liveGeminiModel(process.env.GEMINI_MODEL_FALLBACK),
              "gemini-flash-latest",
              "gemini-3.6-flash",
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
      /* 401/403 = คีย์ผิด หมดโควตา หรือถูกปิดสิทธิ์ — ลองอีกสิบวินาทีก็ไม่หาย
         พักยาวหน่อยแล้วให้คนที่ยังดีขึ้นมาก่อน ไม่งั้นทุกข้อความเสียรอบยิงทิ้ง */
      if (res.status === 401 || res.status === 403) markRateLimited(provider, 30 * 60_000);
      lastErr = new ProviderHttpError(provider, res.status, text);
      // Model gone / renamed / decommissioned → try the next alias before failing
      // the whole provider (Groq retired llama-3.3-70b-versatile on 2026-08-16).
      const modelGone =
        res.status === 404 ||
        /not found|no longer available|decommission|deprecat|does not exist|model_not_found/i.test(text);
      if ((provider === "gemini" || provider === "groq" || provider === "ark") && modelGone) {
        console.warn(`[llm] ${provider} model ${model} → ${res.status}; trying next alias`);
        continue;
      }
      throw lastErr;
    }
    const data = await res.json();
    /* usage มาพร้อมคำตอบทุกครั้ง แต่โค้ดเดิมอ่านแค่ content แล้วทิ้งที่เหลือ
       จึงไม่มีใครตอบได้ว่าเดือนนี้ใช้ไปเท่าไหร่ — เก็บตรงนี้ที่เดียวครบทุกทาง */
    const u = data.usage || {};
    recordUsage({
      provider,
      model,
      task: opts?.task || (opts?.fast ? "intent" : opts?.json ? "parse" : "chat"),
      promptTokens: Number(u.prompt_tokens || u.input_tokens || 0),
      completionTokens: Number(u.completion_tokens || u.output_tokens || 0),
    });
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
  /* ไล่ครบทุกชื่อรุ่นแล้วยังไม่มีอันไหนตอบ — ฝั่งนั้นยังไม่ได้เปิดใช้ หรือเปลี่ยนชื่อยกชุด
     พักไว้สิบนาที จะได้ไม่ต้องไล่ยิงทุกชื่อใหม่ทุกข้อความ */
  if (lastErr?.status === 404) markRateLimited(provider, 10 * 60_000);
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
    /* ชื่องานสำหรับหน้านับค่า AI: news / meeting / ocr / intent / chat */
    task?: string;
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
  const known: Provider[] = ["qwen", "groq", "gemini", "ark"];
  const raw = (process.env.LLM_PROVIDER || "groq,gemini").toLowerCase();
  const chain = raw.split(",").map((s) => s.trim()).filter((p) => known.includes(p as Provider));
  const order = chain.length ? chain : known;
  const keyEnv: Record<Provider, string> = {
    qwen: process.env.QWEN_API_KEY ? "QWEN_API_KEY" : process.env.DASHSCOPE_API_KEY ? "DASHSCOPE_API_KEY" : "QWEN_API_KEY",
    groq: "GROQ_API_KEY",
    gemini: process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : "GEMINI_API_KEY",
    ark: "ARK_API_KEY",
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
