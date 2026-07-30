// Task follow-up + reminders — ported from morning_brief/followup.py.
import { createHash } from "crypto";
import { Attendee, resolveAttendee, resolveUser } from "@/lib/graph";
import { sendLine } from "@/lib/line";
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

function formatReminder(tasks: Task[]): string {
  const lines = ["⏰ แจ้งเตือน: มีงานที่เลยกำหนดแล้วยังไม่เสร็จ", ""];
  for (const t of tasks) {
    const who = t.responsible || "ไม่ระบุผู้รับผิดชอบ";
    const src = t.source ? ` (จาก: ${t.source})` : "";
    lines.push(`  • ${t.title} — ${who} | กำหนด ${t.due}${src}`);
  }
  lines.push("", "ทำเสร็จแล้วกดปิดงานได้ที่หน้าเว็บ");
  return lines.join("\n");
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
  for (const [upn, tasks] of byRecipient) {
    try {
      await sendLine(upn, "⏰ งานที่เลยกำหนด", formatReminder(tasks));
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
