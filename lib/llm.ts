// Minimal LLM client (Groq's OpenAI-compatible API). Swap to Azure OpenAI later
// by changing the endpoint/model. Always replies in Thai (primary) / English only.
const LANGUAGE_RULE =
  "\n\nกติกาภาษา: ตอบเป็นภาษาไทยเป็นหลักเสมอ ใช้อังกฤษเฉพาะศัพท์เทคนิค/ชื่อเฉพาะ ห้ามตอบภาษาอื่นเด็ดขาด";

export async function chat(
  system: string,
  user: string,
  opts?: { json?: boolean; temperature?: number }
): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  if (!key) throw new Error("GROQ_API_KEY not set");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: opts?.temperature ?? 0.3,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system + (opts?.json ? "" : LANGUAGE_RULE) },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}
