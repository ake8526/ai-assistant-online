// Did this morning's messages actually go out on time?
//
// The whole point of the prewarm + Cloudflare Worker setup is arrival at the
// minute the user set. If the primary scheduler dies we fall back to Vercel /
// GitHub cron, which are 25-40 min late — and nothing would say so. Nobody
// should have to notice by hand that the brief showed up at 07:37 again.
//
// The Worker calls this once a day after the morning window (08:30 BKK). It
// compares each user's `*_last_sent` stamp with their configured time and, if
// anything was late or never arrived, reports once to the operator.
//
//   ?dry=1  compute and return the report without sending or marking it
//   ?to=    override who gets the report (defaults: settings _ops/punctuality_admin,
//           then PUNCTUALITY_ADMIN_UPN; with neither, the report is trace-only)
//
// See docs/morning-delivery-plan.md.
import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { resolveLinkedUpn, sendLine } from "@/lib/line";
import {
  bkkNowParts,
  notifyConfigFromSettings,
  NOTIFY_STATE_KEYS,
  type NotifyKind,
} from "@/lib/notify";
import { getSetting, getSettingsFor, setSetting } from "@/lib/store";
import { runWithTrace, trace } from "@/lib/trace";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

/** Arriving this many minutes after the set time counts as late. */
const LATE_THRESHOLD_MIN = 5;

const OPS_BUCKET = "_ops";
const ADMIN_KEY = "punctuality_admin";
const REPORTED_KEY = "punctuality_reported";

const KIND_LABEL: Record<NotifyKind, string> = { news: "ข่าว", brief: "สรุปประชุม" };

type Verdict = {
  upn: string;
  kind: NotifyKind;
  due: string;
  sent: string | null;
  lateMin: number;
  status: "ontime" | "late" | "missing" | "unknown";
};

/** "2026-08-13T07:29:05+07:00" → 449 (minutes into the Bangkok day). The stamp is
 *  already Bangkok wall-clock, so the time part can be read straight off. */
function stampMinutes(raw: string): number | null {
  const m = raw.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);
  if (!m) return null; // legacy date-only row — no time to judge
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function timeOfMinutes(min: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
}

function judge(upn: string, rows: Record<string, string>): Verdict[] {
  const at = bkkNowParts();
  const cfg = notifyConfigFromSettings(rows);
  const out: Verdict[] = [];
  for (const kind of ["news", "brief"] as NotifyKind[]) {
    const k = cfg[kind];
    if (!k.enabled || !k.days.includes(at.day)) continue;
    const [hh, mm] = k.time.split(":").map((x) => parseInt(x, 10));
    const dueMin = (hh || 0) * 60 + (mm || 0);
    // Not yet past the point where lateness is even decidable.
    if (at.min < dueMin + LATE_THRESHOLD_MIN) continue;

    const raw = rows[`${kind}_last_sent`] || "";
    if (raw.slice(0, 10) !== at.date) {
      out.push({ upn, kind, due: k.time, sent: null, lateMin: at.min - dueMin, status: "missing" });
      continue;
    }
    const sentMin = stampMinutes(raw);
    if (sentMin === null) {
      out.push({ upn, kind, due: k.time, sent: raw, lateMin: 0, status: "unknown" });
      continue;
    }
    const lateMin = sentMin - dueMin;
    out.push({
      upn,
      kind,
      due: k.time,
      sent: timeOfMinutes(sentMin),
      lateMin,
      status: lateMin > LATE_THRESHOLD_MIN ? "late" : "ontime",
    });
  }
  return out;
}

function formatReport(problems: Verdict[], date: string): string {
  const lines = problems.map((v) => {
    const who = v.upn.split("@")[0];
    const what = KIND_LABEL[v.kind];
    if (v.status === "missing") {
      return `• ${who} — ${what}: ยังไม่ส่ง (เลยเวลา ${v.due} มา ${v.lateMin} นาที)`;
    }
    if (v.status === "unknown") {
      return `• ${who} — ${what}: ส่งแล้ววันนี้ แต่ไม่มีเวลาบันทึกไว้ (ข้อมูลเก่า)`;
    }
    return `• ${who} — ${what}: ตั้ง ${v.due} ส่ง ${v.sent} (ช้า ${v.lateMin} นาที)`;
  });
  return [
    `⏰ ส่งไม่ตรงเวลา (${date})`,
    "",
    ...lines,
    "",
    `เกินเป้า ${LATE_THRESHOLD_MIN} นาที — ตัวยิงหลักอาจล่ม`,
    "ตรวจ Cloudflare Worker: npx wrangler tail",
  ].join("\n");
}

async function resolveOperator(req: Request): Promise<string> {
  const q = (new URL(req.url).searchParams.get("to") || "").trim();
  if (q) return (await resolveLinkedUpn(q)) || q.toLowerCase();
  const stored = await getSetting(OPS_BUCKET, ADMIN_KEY);
  if (stored) return stored;
  return (process.env.PUNCTUALITY_ADMIN_UPN || "").trim().toLowerCase();
}

async function run(req: Request) {
  try {
    assertConfigured();
    if (!checkCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const dry = new URL(req.url).searchParams.get("dry") === "1";
    const at = bkkNowParts();
    const { data } = await admin.from("line_links").select("upn");
    const users = (data || []).map((r) => r.upn);
    const rows = await getSettingsFor(users, NOTIFY_STATE_KEYS);

    const verdicts = users.flatMap((upn) => judge(upn, rows[upn] || {}));
    const problems = verdicts.filter((v) => v.status !== "ontime");
    // "unknown" only means a legacy date-only row that carries no send time; it
    // heals itself on the next send and is not worth waking anyone for. Alert on
    // real lateness, and let the unknown rows ride along as context.
    const alertable = problems.filter((v) => v.status === "late" || v.status === "missing");

    if (!alertable.length) {
      return NextResponse.json({
        ok: true,
        date: at.date,
        onTime: verdicts.filter((v) => v.status === "ontime").length,
        problems,
        sent: "skip (nothing late)",
      });
    }

    const already = await getSetting(OPS_BUCKET, REPORTED_KEY);
    if (!dry && already === at.date) {
      return NextResponse.json({ ok: true, date: at.date, problems, sent: "skip (reported today)" });
    }

    const report = formatReport(problems, at.date);
    const operator = await resolveOperator(req);
    let sent = "trace-only (no operator configured)";
    await runWithTrace({ upn: operator || undefined, channel: "cron" }, async () => {
      trace("receive", "cron · ตรวจความตรงเวลาการส่งเช้า");
      trace("error", `⏰ ส่งช้า/ไม่ส่ง ${alertable.length} รายการ`, "error");
      if (dry) {
        sent = "dry run (not sent)";
        return;
      }
      if (!operator) return;
      try {
        await sendLine(operator, "", report);
        await setSetting(OPS_BUCKET, REPORTED_KEY, at.date);
        sent = `reported to ${operator}`;
        trace("reply", "⏰ แจ้งผู้ดูแลแล้ว");
      } catch (e) {
        sent = `ERROR: ${String(e).slice(0, 150)}`;
      }
    });

    return NextResponse.json({ ok: true, date: at.date, problems, report, sent });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return run(req);
}

export async function POST(req: Request) {
  return run(req);
}
