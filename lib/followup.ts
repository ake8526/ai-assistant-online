// Task follow-up + reminders — ported from morning_brief/followup.py.
import { createHash } from "crypto";
import { Attendee, resolveAttendee, resolveUser } from "@/lib/graph";
import { getLineId, pushLineMessages, pushQuotaGone, sendLine } from "@/lib/line";
import { Task, addTask, duePendingTasks, markReminded, updateTaskStatus } from "@/lib/store";

const NOTIFY_RESPONSIBLE = (process.env.NOTIFY_RESPONSIBLE || "true").toLowerCase() === "true";

// Owner values that mean "nobody was named"
const UNASSIGNED = new Set(["", "ไม่ระบุ", "ไม่ระบุผู้รับผิดชอบ", "none", "null", "-", "n/a", "tbd"]);

export type ActionItem = {
  task?: string;
  owner?: string;
  due?: string | null;
  _meeting?: string;
  _owner_user?: string;
  _attendees?: Attendee[];
};

function dedupKey(ownerUpn: string, meeting: string, task: string): string {
  return createHash("sha1").update(`${ownerUpn}|${meeting}|${task}`.toLowerCase(), "utf8").digest("hex");
}

/** Map a responsible person's name to an M365 mailbox (restricted to meeting attendees when given). */
export async function resolveResponsible(name: string, attendees?: Attendee[]): Promise<string | null> {
  if (!NOTIFY_RESPONSIBLE) return null;
  if (!name || UNASSIGNED.has(name.trim().toLowerCase())) return null;
  try {
    if (attendees) return resolveAttendee(name, attendees);
    return await resolveUser(name);
  } catch {
    return null; // a lookup failure must not block ingestion
  }
}

import { normalizeDue } from "@/lib/time";

const APP_BASE = (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/+$/, "");
export { normalizeDue };

/** Store meeting action items as tasks (deduped). Returns count of newly-added tasks. */
export async function ingestActionItems(actionItems: ActionItem[]): Promise<number> {
  let added = 0;
  const newTasks: {
    title: string;
    responsible: string;
    responsible_upn: string | null;
    due: string | null;
    source: string;
    owner_upn: string;
  }[] = [];

  for (const it of actionItems) {
    const ownerUpn = it._owner_user || "";
    const meeting = it._meeting || "";
    const task = (it.task || "").trim();
    if (!ownerUpn || !task) continue;
    const responsible = it.owner || "";
    const responsibleUpn = await resolveResponsible(responsible, it._attendees);
    const due = normalizeDue(it.due);
    const newId = await addTask({
      owner_upn: ownerUpn,
      title: task,
      responsible,
      responsible_upn: responsibleUpn,
      due,
      source: meeting,
      dedup_key: dedupKey(ownerUpn, meeting, task),
    });
    if (newId !== null) {
      added += 1;
      newTasks.push({ title: task, responsible, responsible_upn: responsibleUpn, due, source: meeting, owner_upn: ownerUpn });
    }
  }
  await notifyNewAssignments(newTasks);
  return added;
}

function formatAssignment(tasks: { title: string; due: string | null; source: string }[]): string {
  const lines = ["📥 คุณได้รับมอบหมายงานจากการประชุม", ""];
  for (const t of tasks) {
    const due = t.due || "ไม่ระบุกำหนด";
    const src = t.source ? ` (จาก: ${t.source})` : "";
    lines.push(`  • ${t.title} — กำหนด ${due}${src}`);
  }
  lines.push("", "ระบบจะช่วยเตือนเมื่อใกล้/เลยกำหนดให้อีกทีครับ");
  return lines.join("\n");
}

async function notifyNewAssignments(
  newTasks: { title: string; responsible_upn: string | null; due: string | null; source: string; owner_upn: string }[]
): Promise<void> {
  const byPerson = new Map<string, typeof newTasks>();
  for (const t of newTasks) {
    if (t.responsible_upn && t.responsible_upn !== t.owner_upn) {
      if (!byPerson.has(t.responsible_upn)) byPerson.set(t.responsible_upn, []);
      byPerson.get(t.responsible_upn)!.push(t);
    }
  }
  for (const [upn, tasks] of byPerson) {
    try {
      await sendLine(upn, "📥 งานที่ได้รับมอบหมาย", formatAssignment(tasks));
    } catch (e) {
      console.log(`assignment notify failed for ${upn}: ${e}`);
    }
  }
}

/** Bangkok-readable due date — the raw UTC ISO string was unreadable in chat. */
function fmtDue(due: string | null): string {
  if (!due) return "ไม่ระบุกำหนด";
  const d = new Date(due);
  if (isNaN(d.getTime())) return due;
  const bkk = new Date(d.getTime() + 7 * 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(bkk.getUTCDate())}/${pad(bkk.getUTCMonth() + 1)}/${bkk.getUTCFullYear()} ${pad(bkk.getUTCHours())}:${pad(bkk.getUTCMinutes())}`;
}

function formatReminder(tasks: Task[]): string {
  const lines = ["⏰ แจ้งเตือน: มีงานที่เลยกำหนดแล้วยังไม่เสร็จ", ""];
  tasks.forEach((t, i) => {
    const who = t.responsible || "ไม่ระบุผู้รับผิดชอบ";
    const src = t.source ? ` (จาก: ${t.source})` : "";
    lines.push(`  ${i + 1}) ${t.title} — ${who} | กำหนด ${fmtDue(t.due)}${src}`);
  });
  lines.push("", "กดเลขด้านล่างเพื่อปิดงาน หรือพิมพ์ «ปิดงาน <ชื่องาน>»");
  // The old wording said "close it on the web page" without ever saying which page.
  lines.push(`ดูงานทั้งหมด: ${APP_BASE}/`);
  return lines.join("\n");
}

/** One numbered close-button per task, same shape as the agenda's prep buttons. */
function reminderQuickReply(tasks: Task[]): { items: object[] } {
  return {
    items: tasks.slice(0, 12).map((t, i) => ({
      type: "action",
      action: {
        type: "postback",
        label: `${i + 1}`,
        data: `a=done&t=${t.id}`,
        displayText: `ปิดงาน ${i + 1}) ${t.title}`.slice(0, 60),
      },
    })),
  };
}

function recipientsFor(task: Task): string[] {
  const who = [task.owner_upn];
  if (NOTIFY_RESPONSIBLE && task.responsible_upn && task.responsible_upn !== task.owner_upn) {
    who.push(task.responsible_upn);
  }
  return who;
}

/** Remind owners + responsible people about overdue tasks, then mark them overdue. */
export async function checkDue(): Promise<Record<string, number>> {
  // Nothing left to push with, so there is nothing to try.
  //
  // The reminder tick runs every minute (cloudflare/src/worker.js) so that a
  // due task lands on the minute. With the monthly push quota at zero that
  // became the same reminder failing sixty times an hour, every hour, for the
  // rest of the month — a screenful of identical LineQuotaError rows in
  // /monitor/log, and a room that looks busy while nobody is doing anything.
  // The quota resets with the billing month, never later today, so retrying
  // sooner cannot help. Same guard the morning brief already uses; the reading
  // is cached, so asking costs nothing per tick.
  if (await pushQuotaGone()) {
    console.log("reminders: skipped — LINE push quota exhausted this month");
    return {};
  }
  const overdue = await duePendingTasks();

  const byRecipient = new Map<string, Task[]>();
  for (const t of overdue) {
    for (const upn of recipientsFor(t)) {
      if (!byRecipient.has(upn)) byRecipient.set(upn, []);
      byRecipient.get(upn)!.push(t);
    }
  }

  const reminded: Record<string, number> = {};
  const deliveredIds = new Set<number>();
  const { runWithTrace, trace } = await import("@/lib/trace");
  for (const [upn, tasks] of byRecipient) {
    try {
      await runWithTrace({ upn, channel: "cron" }, async () => {
        trace("receive", "cron · เตือนงานเลยกำหนด");
        trace("compose", `งาน ${tasks.length} รายการ`);
        try {
          const lineId = await getLineId(upn);
          if (lineId) {
            const body = `⏰ งานที่เลยกำหนด\n\n${formatReminder(tasks)}`;
            await pushLineMessages(lineId, [
              { type: "text", text: body.slice(0, 4900), quickReply: reminderQuickReply(tasks) },
            ]);
          } else {
            await sendLine(upn, "⏰ งานที่เลยกำหนด", formatReminder(tasks));
          }
        } catch (e) {
          // Record WHY nothing arrived (quota exhausted, unlinked, LINE error) —
          // a bare missing "reply" step is what made this hard to diagnose.
          trace("error", `ส่งเตือนไม่ได้: ${String(e).slice(0, 90)}`, "error");
          throw e;
        }
        trace("reply", "ส่งเตือน LINE");
      });
      reminded[upn] = tasks.length;
      for (const t of tasks) deliveredIds.add(t.id);
    } catch (e) {
      console.log(`reminder failed for ${upn}: ${e}`);
    }
  }
  for (const tid of deliveredIds) {
    await updateTaskStatus(tid, "overdue");
    await markReminded(tid);
  }
  return reminded;
}
