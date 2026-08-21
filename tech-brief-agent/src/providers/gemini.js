// Google Gemini (Generative Language REST). Research uses google_search grounding.
// Key is sent via x-goog-api-key header (never in the URL). Verify at
// https://ai.google.dev/gemini-api/docs
export function makeGemini({ key, model, searchModel }) {
  const MODEL = model || "gemini-2.0-flash";
  const SEARCH_MODEL = searchModel || MODEL;
  const H = { "Content-Type": "application/json", "x-goog-api-key": key };

  async function gen(m, system, user, tools) {
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    };
    if (tools) body.tools = tools;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: "POST", headers: H, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }

  return {
    async research(system, user) {
      return gen(SEARCH_MODEL, system, user, [{ google_search: {} }]);
    },
    async format(system, user) {
      return gen(MODEL, system, user, null);
    },
  };
}
