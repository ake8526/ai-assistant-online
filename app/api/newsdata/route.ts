import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";
import { isNewsDataConfigured, newsDataEnvDefaults } from "@/lib/newsdata";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const ENABLED = "newsdata_enabled";
const LANGUAGES = "newsdata_languages";
const COUNTRIES = "newsdata_countries";
const KEYWORDS = "newsdata_keywords";
const CATEGORIES = "newsdata_categories";

export type NewsDataConfig = {
  /** Server has NEWSDATA_API_KEY (key itself is never returned). */
  configured: boolean;
  enabled: boolean;
  languages: string;
  countries: string;
  keywords: string;
  categories: string;
};

async function loadConfig(upn: string): Promise<NewsDataConfig> {
  const defaults = newsDataEnvDefaults();
  const configured = isNewsDataConfigured();
  const [en, languages, countries, keywords, categories] = await Promise.all([
    getSetting(upn, ENABLED),
    getSetting(upn, LANGUAGES),
    getSetting(upn, COUNTRIES),
    getSetting(upn, KEYWORDS),
    getSetting(upn, CATEGORIES),
  ]);
  return {
    configured,
    enabled: en === null ? configured : en === "1",
    languages: languages || defaults.languages,
    countries: countries || defaults.countries,
    keywords: keywords ?? defaults.keywords,
    categories: categories ?? defaults.categories,
  };
}

/** GET — status + per-user filters (never returns the API key). */
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

/** POST — toggle / filters only (API key is server env). */
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const body = await req.json();

    if (typeof body.enabled === "boolean") {
      await setSetting(upn, ENABLED, body.enabled ? "1" : "0");
    }
    if (typeof body.languages === "string") await setSetting(upn, LANGUAGES, body.languages.trim());
    if (typeof body.countries === "string") await setSetting(upn, COUNTRIES, body.countries.trim());
    if (typeof body.keywords === "string") await setSetting(upn, KEYWORDS, body.keywords.trim());
    if (typeof body.categories === "string") await setSetting(upn, CATEGORIES, body.categories.trim());

    return NextResponse.json(await loadConfig(upn), { headers: NO_STORE });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
