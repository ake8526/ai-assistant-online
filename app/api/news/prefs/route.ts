import { NextResponse } from "next/server";
import { AuthError, resolveUser } from "@/lib/auth";
import { finishWebOnboarding } from "@/lib/newsOnboarding";
import {
  getNewsPrefs,
  setNewsInterested,
  setNewsOnboardingDone,
  setNewsTopics,
} from "@/lib/newsPrefs";
import { getNotifyConfig, saveNotifyKind } from "@/lib/notify";
import { hasMicrosoftToken } from "@/lib/msGraphOAuth";
import { assertConfigured } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET — topics + notify prefs for web setup. */
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const [prefs, notify, calLinked] = await Promise.all([
      getNewsPrefs(upn),
      getNotifyConfig(upn),
      hasMicrosoftToken(upn),
    ]);
    return NextResponse.json({ prefs, notify, calLinked }, { headers: NO_STORE });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}

/** POST — save web setup (topics + schedules). complete=true → finish onboarding + LINE summary. */
export async function POST(req: Request) {
  try {
    assertConfigured();
    const upn = await resolveUser(req);
    const body = await req.json();

    if (Array.isArray(body.topics)) {
      await setNewsTopics(upn, body.topics.map((t: unknown) => String(t)));
    }
    if (typeof body.interested === "boolean") {
      await setNewsInterested(upn, body.interested);
    }

    const news = body.news;
    if (news && typeof news === "object") {
      const patch: { enabled?: boolean; time?: string; days?: number[]; count?: number } = {};
      if (typeof news.enabled === "boolean") patch.enabled = news.enabled;
      if (typeof news.time === "string") patch.time = news.time;
      if (Array.isArray(news.days)) patch.days = news.days.map((n: unknown) => Number(n));
      if (news.count !== undefined) patch.count = Number(news.count);
      await saveNotifyKind(upn, "news", patch);
    }

    const brief = body.brief;
    if (brief && typeof brief === "object") {
      const patch: { enabled?: boolean; time?: string; days?: number[] } = {};
      if (typeof brief.enabled === "boolean") patch.enabled = brief.enabled;
      if (typeof brief.time === "string") patch.time = brief.time;
      if (Array.isArray(brief.days)) patch.days = brief.days.map((n: unknown) => Number(n));
      await saveNotifyKind(upn, "brief", patch);
    }

    if (body.complete === true) {
      await setNewsInterested(upn, true);
      await finishWebOnboarding(upn);
    } else if (body.complete === false) {
      await setNewsOnboardingDone(upn, false);
    }

    const [prefs, notify, calLinked] = await Promise.all([
      getNewsPrefs(upn),
      getNotifyConfig(upn),
      hasMicrosoftToken(upn),
    ]);
    return NextResponse.json({ ok: true, prefs, notify, calLinked }, { headers: NO_STORE });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: String(e instanceof AuthError ? e.message : e) }, { status });
  }
}
