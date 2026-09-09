import { NextResponse } from "next/server";
import { AuthError, checkCronSecret, requireUser } from "@/lib/auth";
import { buildMorningAgenda } from "@/lib/brief";
import { rememberDeliveredStories } from "@/lib/digest";
import { pushQuotaGone, resolveLinkedUpn, sendLine } from "@/lib/line";
import { jobSkipReason } from "@/lib/jobHealth";
import { clearBriefPrewarm, clearNewsPrewarm } from "@/lib/morningCache";
import { withDelegatedGraph } from "@/lib/msGraphOAuth";
import {
  claimSend,
  clearInflight,
  dueNowForUsers,
  getNotifyConfig,
  isDueNow,
  markSent,
} from "@/lib/notify";
import { bkkNowParts } from "@/lib/notify";
import { buildMorningPreview } from "@/lib/newsPage";
import { getLineId, pushLineMessages } from "@/lib/line";
import { addNotice } from "@/lib/inbox";
import { runWithTrace, trace } from "@/lib/trace";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 300;

async function linkedUsers(): Promise<string[]> {
  const { data } = await admin.from("line_links").select("upn");
  return (data || []).map((r) => r.upn);
}

type OnlyKind = "brief" | "news" | "both";

function parseOnly(req: Request): OnlyKind {
  const v = (new URL(req.url).searchParams.get("only") || "both").toLowerCase();
  if (v === "brief" || v === "news") return v;
  return "both";
}

/**
 * ข้อความเช้าหนึ่งข้อความต่อคน — ตารางกับข่าวอยู่ด้วยกัน
 *
 * เดิมเป็นสองข้อความ: ข่าว 07:00 แล้วตาราง 07:01 ที่ต้องมาทีหลังเพราะปุ่มเลข
 * ต้องอยู่บนข้อความล่าสุด ผลคือเช้าหนึ่งกิน push สองใบต่อคน ซึ่งกับโควตา
 * 300 ใบต่อเดือนแปลว่าหมดกลางเดือนทุกเดือน (4 ก.ย. 2569 ใช้ไป 151 ใบตั้งแต่
 * วันที่ 4) และข้อความตารางที่เทมาทั้งวันก็ยาวจน LINE พับไว้หลัง "See more"
 * ลิงก์ข่าวที่อยู่ท้ายสุดเลยไม่มีใครเจอ
 *
 * ตอนนี้บอกจำนวนนัดแล้วให้กดเลือกดูครึ่งวันเอา การกางดูเป็น reply ซึ่งไม่เสีย
 * โควตา ส่วนคนที่ปิดข่าวไว้ก็ไม่มีบรรทัดข่าวและไม่เสียเวลาไปดึงข่าวให้
 */
async function pushMorning(
  upn: string,
  force: boolean,
  paused: { brief: string | null; news: string | null }
): Promise<{ brief: string; news: string }> {
  if (paused.brief) return { brief: `skip (${paused.brief})`, news: `skip (${paused.brief})` };

  return runWithTrace({ upn, channel: "cron" }, async () => {
    if (!force && !(await isDueNow(upn, "brief"))) {
      return { brief: "skip (not due)", news: "skip (not due)" };
    }
    trace("receive", "cron · ข้อความเช้า");

    // ข่าวไปด้วยไหม ตัดสินจากค่าที่เจ้าตัวตั้งไว้ ไม่ใช่จากค่ากลาง
    const cfg = await getNotifyConfig(upn);
    const today = bkkNowParts().day;
    const withNews = !paused.news && cfg.news.enabled && cfg.news.days.includes(today);

    if (!force && !(await claimSend(upn, "brief"))) {
      return { brief: "skip (inflight or sent)", news: "skip (inflight or sent)" };
    }

    let p: Awaited<ReturnType<typeof buildMorningPreview>>;
    try {
      // fastNews: รอบเช้ามีเพดานเวลา ปกติ prewarm เตรียมไว้ให้แล้วตั้งแต่ 06:5x
      // พลาดขึ้นมาก็ยอมได้ข่าวแบบเร็ว ดีกว่าไม่ได้อะไรเลยเพราะหมดเวลา
      p = await buildMorningPreview(upn, { fastNews: true, withNews });
    } catch (e) {
      const msg =
        "🌅 สรุปเช้านี้\n\nดึงตารางจาก Outlook ไม่สำเร็จตอนนี้ครับ\n" +
        `เหตุผล: ${String(e).slice(0, 120)}\n\nพิมพ์ «สรุปตารางเช้า» เพื่อลองใหม่`;
      try {
        await sendLine(upn, "", msg, true);
        await markSent(upn, "brief");
        trace("reply", "แจ้ง error กราฟ", "error");
        return { brief: "delivered graph-error notice", news: "skip (brief failed)" };
      } catch (e2) {
        trace("error", `แจ้ง error ไม่สำเร็จ · ${String(e2).slice(0, 120)}`, "error");
        await clearInflight(upn, "brief");
        return { brief: `ERROR: ${String(e).slice(0, 150)}`, news: "skip (brief failed)" };
      }
    }

    /* เก็บเข้ากล่องในแอปเสมอ และเก็บ "ตารางแบบเต็ม" ไม่ใช่ฉบับย่อ — กล่องในแอป
       มีที่ให้อ่านและไม่มีปุ่มให้กดกางดู ถ้าเก็บฉบับย่อไว้จะกลายเป็นบันทึกที่
       บอกแค่จำนวน แล้วย้อนดูไม่ได้ว่าวันนั้นมีนัดอะไรบ้าง */
    const noticeBody = [p.agendaText.trim(), p.newsCount ? `\n📰 ข่าวเช้า ${p.newsCount} เรื่อง\n${p.newsUrl}` : ""]
      .filter(Boolean)
      .join("\n");
    await addNotice(upn, { kind: "brief", title: "🌅 สรุปเช้านี้", body: noticeBody }).catch(() => {});

    const lineId = await getLineId(upn);
    if (!lineId) {
      await markSent(upn, "brief");
      if (withNews) await markSent(upn, "news");
      trace("reply", "ยังไม่ได้ผูก LINE — เก็บเข้ากล่องในแอปอย่างเดียว", "skip");
      return { brief: "notice only (no line link)", news: withNews ? "in brief" : "off" };
    }

    const quickItems = p.halves.slice(0, 3).map((h) => ({
      type: "action",
      action: {
        type: "postback",
        label: `${h.label} (${h.count})`.slice(0, 20),
        data: `a=half&h=${h.key}`,
        displayText: `ดูนัด${h.label}`,
      },
    }));

    try {
      await pushLineMessages(
        lineId,
        [
          {
            type: "text",
            text: p.message.slice(0, 4900),
            ...(quickItems.length ? { quickReply: { items: quickItems } } : {}),
          },
        ],
        true
      );
      await markSent(upn, "brief");
      await clearBriefPrewarm(upn);
      if (withNews) {
        await markSent(upn, "news");
        await clearNewsPrewarm(upn);
        /* จำว่าส่งข่าวชุดนี้ไปแล้ว — ของเดิมทำตรงนี้ ถ้าไม่ต่อกลับมา buildDigest
           พรุ่งนี้จะหยิบข่าวเดิมมาส่งซ้ำเพราะไม่รู้ว่าเคยส่งแล้ว */
        await rememberDeliveredStories(upn, p.delivered).catch(() => {});
      }
      trace("reply", `ส่งข้อความเช้า · นัด ${p.halves.reduce((n, h) => n + h.count, 0)} · ข่าว ${p.newsCount}`);
      return {
        brief: `delivered (${p.halves.reduce((n, h) => n + h.count, 0)} meetings)`,
        news: withNews ? `in brief (${p.newsCount})` : "off",
      };
    } catch (e) {
      trace("error", `ส่ง LINE ไม่สำเร็จ · ${String(e).slice(0, 120)}`, "error");
      await clearInflight(upn, "brief");
      return { brief: `ERROR: ${String(e).slice(0, 150)}`, news: "skip (send failed)" };
    }
  });
}

/**
 * The Worker calls only=both every minute (cloudflare/src/worker.js).
 * `only` is kept for older callers but no longer splits the send: there is one
 * message now, so asking for "just the news" would mean sending the whole thing
 * anyway. Both keys in the result describe that single message.
 */
async function deliverMorningForUser(
  upn: string,
  force: boolean,
  only: OnlyKind,
  /** Set when the job has been paused (by hand or by itself) — reported per user
   *  so the response still says why nobody was served. */
  paused: { brief: string | null; news: string | null } = { brief: null, news: null }
): Promise<{ brief: string; news: string }> {
  void only;
  return pushMorning(upn, force, paused);
}

export async function POST(req: Request) {
  return run(req);
}

export async function GET(req: Request) {
  return run(req);
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (checkCronSecret(req)) {
      const url = new URL(req.url);
      const force = url.searchParams.get("force") === "1";
      const only = parseOnly(req);
      const onlyUpnQuery = (url.searchParams.get("upn") || "").trim();
      let users: string[];
      if (onlyUpnQuery) {
        const resolved = await resolveLinkedUpn(onlyUpnQuery);
        if (!resolved) {
          return NextResponse.json({ ok: false, error: `upn not linked: ${onlyUpnQuery}` }, { status: 404 });
        }
        users = [resolved];
      } else {
        users = await linkedUsers();
      }
      // One query decides who is due, before anything else is asked: outside the
      // delivery window (set time + NOTIFY_LATE_CUTOFF_MIN) there is nobody to
      // serve, so the tick must cost nothing and say nothing — it fires every
      // 5 minutes until 20:55.
      const due = force ? null : await dueNowForUsers(users);
      const anyDue = !due || users.some((u) => due[u]?.news || due[u]?.brief);
      if (!anyDue) {
        return NextResponse.json({ ok: true, only, skipped: "nobody due" });
      }

      // Someone IS due. Nothing can go out until the quota resets with the
      // month, so say it once and stop, instead of rebuilding every brief to
      // fail at the last step. force=1 (a manual send) still goes through.
      if (!force && (await pushQuotaGone())) {
        await runWithTrace({ channel: "cron" }, async () => {
          trace("receive", "cron · สรุปตารางเช้า");
          trace(
            "reply",
            "ข้ามรอบส่ง · โควตา push ของ LINE หมดเดือนนี้ (จะส่งได้อีกครั้งเมื่อโควตารีเซ็ต)",
            "skip"
          );
        });
        return NextResponse.json({ ok: true, only, skipped: "line-quota-exhausted" });
      }
      // Paused from /monitor/log, or paused by itself after half an hour of runs
      // that kept failing. Checked once for the whole tick, not per user.
      const paused = force
        ? { brief: null, news: null }
        : {
            brief: only === "news" ? null : await jobSkipReason("brief"),
            news: only === "brief" ? null : await jobSkipReason("news"),
          };
      const results: Record<string, { brief: string; news: string }> = {};
      for (const upn of users) {
        const d = due?.[upn];
        if (d && !d.news && !d.brief) {
          results[upn] = { brief: "skip (not due)", news: "skip (not due)" };
          continue;
        }
        try {
          results[upn] = await deliverMorningForUser(upn, force, only, paused);
        } catch (e) {
          results[upn] = {
            brief: `ERROR: ${String(e).slice(0, 150)}`,
            news: `ERROR: ${String(e).slice(0, 150)}`,
          };
        }
      }
      return NextResponse.json({ ok: true, only, results });
    }
    const upn = await requireUser(req);
    const { result: agenda } = await withDelegatedGraph(upn, () => buildMorningAgenda(upn));
    return NextResponse.json({ ok: true, brief: agenda.text, meetings: agenda.events.length });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
