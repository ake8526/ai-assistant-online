import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { getSetting, setSetting } from "@/lib/store";
import { pushQuotaGone } from "@/lib/line";
import { pushSurveyInvite, surveySessionAgeMs } from "@/lib/lineSurvey";
import { listSurveyResponses } from "@/lib/surveyResponses";
import { nowWall, wallIso } from "@/lib/time";
import { runWithTrace, trace } from "@/lib/trace";

/**
 * ยิงคำเชิญทำแบบสำรวจให้ทุกคนที่ผูก LINE ไว้ — ครั้งเดียวในวันที่กำหนด
 *
 * ไม่ตั้งเป็นงานประจำ เพราะการทักทุกคนพร้อมกันเป็นเรื่องที่ควรตั้งใจทำเป็นครั้ง ๆ
 * ไม่ใช่สิ่งที่วิ่งเองทุกวันแล้วลืมปิด วันที่จะยิงเก็บไว้ที่ settings `_survey/blast_date`
 * (รูปแบบ YYYY-MM-DD เวลาไทย) นาที 08:30 ของทุกวัน Worker จะแวะมาถาม ถ้าไม่ตรงวัน
 * ก็จบไปเงียบ ๆ ไม่กินอะไร และเมื่อยิงไปแล้วจะปักธงกันยิงซ้ำในวันเดียวกัน
 *
 * ตั้งวันใหม่เมื่อไรก็ใช้ซ้ำได้ ไม่ต้องแก้โค้ดหรือ deploy ใหม่
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const OWNER = "_survey";
const DATE_KEY = "blast_date";
const DONE_KEY = "blast_done";
const SURVEY_ID = "line-short-v2";

/** เซสชันที่ค้างเกินเท่านี้ถือว่าเขาเลิกทำไปแล้ว เริ่มใหม่ให้ได้ */
const STALE_SESSION_MS = 24 * 3600_000;

export async function GET(req: Request) {
  return run(req);
}
export async function POST(req: Request) {
  return run(req);
}

async function run(req: Request) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    assertConfigured();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 503 });
  }

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const force = url.searchParams.get("force") === "1";
  const today = wallIso(nowWall()).slice(0, 10);

  const want = (await getSetting(OWNER, DATE_KEY)) || "";
  if (!force && want !== today) {
    return NextResponse.json({ ok: true, skipped: "not the day", blast_date: want || null, today });
  }
  const done = (await getSetting(OWNER, DONE_KEY)) || "";
  if (!force && done === today) {
    return NextResponse.json({ ok: true, skipped: "already sent today", today });
  }

  const { data } = await admin.from("line_links").select("upn");
  const users = [...new Set((data || []).map((r) => (r.upn as string).toLowerCase()))];

  /* ใครส่งคำตอบไปแล้วไม่ต้องทักซ้ำ — เปลืองโควตาและกวนเขาเปล่า ๆ */
  const answered = new Set<string>();
  try {
    const { rows } = await listSurveyResponses(SURVEY_ID, 500);
    for (const r of rows) {
      const who = String((r as { upn?: string; name?: string }).upn || (r as { name?: string }).name || "")
        .toLowerCase()
        .trim();
      if (who) answered.add(who.includes("@") ? who : `${who}@ktisgroup.com`);
    }
  } catch {
    /* อ่านคำตอบเดิมไม่ได้ก็ส่งให้ทุกคน ดีกว่าไม่ส่งเลย */
  }

  const plan: { upn: string; action: string }[] = [];
  for (const upn of users) {
    if (answered.has(upn)) {
      plan.push({ upn, action: "ข้าม (ตอบไปแล้ว)" });
      continue;
    }
    const age = await surveySessionAgeMs(upn);
    if (age !== null && age < STALE_SESSION_MS) {
      /* เพิ่งทำค้างไว้ — ยิงใหม่จะล้างคำตอบที่เขาตอบมาแล้วทิ้ง ปล่อยให้ทำต่อ */
      plan.push({ upn, action: "ข้าม (กำลังทำอยู่)" });
      continue;
    }
    plan.push({ upn, action: age === null ? "ส่ง" : "ส่งใหม่ (ค้างเกินวัน)" });
  }

  const toSend = plan.filter((p) => p.action.startsWith("ส่ง"));
  if (dry) {
    return NextResponse.json({ ok: true, dry: true, today, willSend: toSend.length, plan });
  }

  if (!force && (await pushQuotaGone())) {
    return NextResponse.json({ ok: true, skipped: "line-quota-exhausted", willSend: toSend.length });
  }

  const results: Record<string, string> = {};
  await runWithTrace({ channel: "cron" }, async () => {
    trace("receive", `cron · เชิญทำแบบสำรวจ ${toSend.length} คน`);
    for (const p of plan) {
      if (!p.action.startsWith("ส่ง")) {
        results[p.upn] = p.action;
        continue;
      }
      try {
        await pushSurveyInvite(p.upn);
        results[p.upn] = "ส่งแล้ว";
      } catch (e) {
        results[p.upn] = `ล้มเหลว: ${String(e).slice(0, 120)}`;
      }
    }
    const ok = Object.values(results).filter((v) => v === "ส่งแล้ว").length;
    trace("reply", `เชิญทำแบบสำรวจแล้ว ${ok}/${toSend.length} คน`);
  });

  await setSetting(OWNER, DONE_KEY, today);
  return NextResponse.json({ ok: true, today, sent: Object.values(results).filter((v) => v === "ส่งแล้ว").length, results });
}
