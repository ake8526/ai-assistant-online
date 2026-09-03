/**
 * รายงานสัปดาห์ — รอบอัตโนมัติศุกร์เย็น
 *
 * ส่งเฉพาะคนที่เปิดสวิตช์ไว้เอง (settings `weekly_report` = "on") ไม่ใช่ทุกคน
 * โดยตั้งใจ: โควตา push 300 ข้อความ/เดือนใช้ร่วมกับบรีฟเช้า ข่าว และการเตือนงาน
 * เปิดให้ทุกคนอัตโนมัติ = กินโควตาเดือนละหลายสิบข้อความโดยไม่มีใครขอ
 *
 * สั่งดูเองในแชทได้ตลอด (intent weekly_report) ซึ่งเป็น reply จึงไม่กินโควตาเลย
 */
import { addNotice } from "@/lib/inbox";
import { getLineId, pushLineToId, pushQuotaGone } from "@/lib/line";
import { collectPeriod, formatWeekly } from "@/lib/periodSummary";
import { getSetting, setSetting } from "@/lib/store";
import { admin } from "@/lib/supabaseServer";
import { addDays, endOfDay, fmtDate, nowWall, startOfDay } from "@/lib/time";

const KEY = "weekly_report";
/** กันส่งซ้ำเมื่อ worker ยิงหลายรอบในนาทีเดียวกัน — เก็บวันที่ส่งล่าสุด */
const SENT_KEY = "weekly_report_sent";

export async function weeklyReportUsers(): Promise<string[]> {
  const { data, error } = await admin.from("settings").select("owner_upn").eq("key", KEY).eq("value", "on");
  if (error) throw new Error(`weeklyReportUsers: ${error.message}`);
  return [...new Set((data || []).map((r) => String(r.owner_upn || "").toLowerCase()).filter(Boolean))];
}

export async function runWeeklyReport(opts?: { dry?: boolean; only?: string }): Promise<{
  sent: number;
  skipped: string[];
  users: number;
  preview?: string;
}> {
  const users = opts?.only ? [opts.only.toLowerCase()] : await weeklyReportUsers();
  const skipped: string[] = [];
  if (!users.length) return { sent: 0, skipped, users: 0 };

  const quotaGone = opts?.dry ? true : await pushQuotaGone();
  const today = startOfDay(nowWall());
  const stamp = fmtDate(today);
  let sent = 0;
  let preview: string | undefined;

  for (const upn of users) {
    try {
      if (!opts?.dry && (await getSetting(upn, SENT_KEY)) === stamp) {
        skipped.push(`${upn}: ส่งไปแล้ววันนี้`);
        continue;
      }
      const [past, ahead] = await Promise.all([
        collectPeriod(upn, addDays(today, -6), endOfDay(today)),
        collectPeriod(upn, addDays(today, 1), addDays(today, 8)),
      ]);
      const label = `สรุปสัปดาห์นี้ (${fmtDate(addDays(today, -6))} – ${fmtDate(today)})`;
      const body = formatWeekly(past, ahead, label);
      if (opts?.dry) {
        preview = preview || body;
        continue;
      }
      await addNotice(upn, { kind: "task", title: "รายงานสัปดาห์", body });
      if (quotaGone) {
        skipped.push(`${upn}: โควตา push หมด (เก็บไว้ในกล่องแจ้งเตือนแล้ว)`);
      } else {
        const lineId = await getLineId(upn);
        if (!lineId) {
          skipped.push(`${upn}: ยังไม่ได้ผูก LINE`);
        } else {
          await pushLineToId(lineId, body);
          sent++;
        }
      }
      await setSetting(upn, SENT_KEY, stamp);
    } catch (e) {
      skipped.push(`${upn}: ${String(e).slice(0, 120)}`);
    }
  }
  return { sent, skipped, users: users.length, preview };
}
