import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { deleteSetting, getSetting, setSetting } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";
import { maskApiKey } from "@/lib/newsdata";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const KEY = "newsdata_api_key";
const ENABLED = "newsdata_enabled";
const LANGUAGES = "newsdata_languages";
const COUNTRIES = "newsdata_countries";
const KEYWORDS = "newsdata_keywords";
const CATEGORIES = "newsdata_categories";

export type NewsDataConfig = {
  configured: boolean;
  enabled: boolean;
  maskedKey: string;
  languages: string;
  countries: string;
  keywords: string;
  categories: string;
};

async function loadConfig(upn: string): Promise<NewsDataConfig> {
  const [key, en, languages, countries, keywords, categories] = await Promise.all([
    getSetting(upn, KEY),
    getSetting(upn, ENABLED),
    getSetting(upn, LANGUAGES),
    getSetting(upn, COUNTRIES),
    getSetting(upn, KEYWORDS),
    getSetting(upn, CATEGORIES),
  ]);
  const hasKey = !!(key && key.trim());
  return {
    configured: hasKey,
    enabled: en === null ? hasKey : en === "1",
    maskedKey: hasKey ? maskApiKey(key!) : "",
    languages: languages || "th",
    countries: countries || "th",
    keywords: keywords || "",
    categories: categories || "",
  };
}

/** GET — NewsData.io settings (API key is masked). */
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    return NextResponse.json(await loadConfig(upn), { headers: NO_STORE });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}

/**
 * POST body:
 *  - api_key?: string (omit or "" to keep; "__clear__" to remove)
 *  - enabled?: boolean
 *  - languages?, countries?, keywords?, categories?: string
 */
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const body = await req.json();

    if (typeof body.api_key === "string") {
      const k = body.api_key.trim();
      if (k === "__clear__") await deleteSetting(upn, KEY);
      else if (k && !k.includes("*")) await setSetting(upn, KEY, k);
    }
    if (typeof body.enabled === "boolean") {
      await setSetting(upn, ENABLED, body.enabled ? "1" : "0");
    }
    if (typeof body.languages === "string") await setSetting(upn, LANGUAGES, body.languages.trim());
    if (typeof body.countries === "string") await setSetting(upn, COUNTRIES, body.countries.trim());
    if (typeof body.keywords === "string") await setSetting(upn, KEYWORDS, body.keywords.trim());
    if (typeof body.categories === "string") await setSetting(upn, CATEGORIES, body.categories.trim());

    if (typeof body.api_key === "string" && body.api_key.trim() && !body.api_key.includes("*")) {
      const en = await getSetting(upn, ENABLED);
      if (en === null) await setSetting(upn, ENABLED, "1");
    }

    return NextResponse.json(await loadConfig(upn), { headers: NO_STORE });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
