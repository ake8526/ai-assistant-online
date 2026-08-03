import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { deleteSetting, getSetting, setSetting } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";
import { maskApiKey } from "@/lib/mediastack";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const KEY = "mediastack_api_key";
const ENABLED = "mediastack_enabled";
const LANGUAGES = "mediastack_languages";
const COUNTRIES = "mediastack_countries";
const KEYWORDS = "mediastack_keywords";
const CATEGORIES = "mediastack_categories";

export type MediaStackConfig = {
  configured: boolean;
  enabled: boolean;
  maskedKey: string;
  languages: string;
  countries: string;
  keywords: string;
  categories: string;
};

async function loadConfig(upn: string): Promise<MediaStackConfig> {
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
    // Default on once a key exists
    enabled: en === null ? hasKey : en === "1",
    maskedKey: hasKey ? maskApiKey(key!) : "",
    languages: languages || "th,en",
    countries: countries || "th",
    keywords: keywords || "",
    categories: categories || "",
  };
}

/** GET — MediaStack settings (API key is masked). */
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
      // ignore masked placeholder values
    }
    if (typeof body.enabled === "boolean") {
      await setSetting(upn, ENABLED, body.enabled ? "1" : "0");
    }
    if (typeof body.languages === "string") await setSetting(upn, LANGUAGES, body.languages.trim());
    if (typeof body.countries === "string") await setSetting(upn, COUNTRIES, body.countries.trim());
    if (typeof body.keywords === "string") await setSetting(upn, KEYWORDS, body.keywords.trim());
    if (typeof body.categories === "string") await setSetting(upn, CATEGORIES, body.categories.trim());

    // Auto-enable when a real key is first saved
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
