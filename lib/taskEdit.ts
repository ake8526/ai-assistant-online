/**
 * แก้เวลางานและตั้งรอบเตือนจากข้อความในไลน์
 *
 * ที่มา: ผู้ใช้พิมพ์ "เปลี่ยนเวลางาน 2 ให้เตือน 2 รอบ รอบ1 เตือน16.00 รอบเตือน17.00"
 * แล้วระบบตอบเรื่องใบลา เพราะไม่มีคำสั่งนี้อยู่จริง — มีแต่ปิดงานกับเพิ่มงาน
 * แก้เวลาได้เฉพาะตอนเพิ่มงานครั้งแรกเท่านั้น
 *
 * เลขงานที่ผู้ใช้พิมพ์คือ "ลำดับในรายการที่เพิ่งเห็น" ไม่ใช่ id ในฐานข้อมูล
 * จึงต้องเรียงงานแบบเดียวกับที่การ์ดงานค้างเรียง ไม่งั้น "งาน 2" ของคนละหน้าจอ
 * จะไม่ใช่งานเดียวกัน
 */

import { listTasks, updateTaskDue, updateTaskStatus, type Task } from "@/lib/store";
import { setAlarms } from "@/lib/taskAlarms";
import {
  addDays,
  fmtDate,
  fmtTime,
  nowWall,
  parseThaiClockToHHMM,
  startOfDay,
  utcIsoToWall,
  wallToUtcIso,
} from "@/lib/time";

/** คำสั่งที่ยอมรับ — ต้องมีคำกริยาแก้ไข + คำว่างาน + เลขลำดับ */
const EDIT_RE =
  /(?:เปลี่ยน|แก้(?:ไข)?|ตั้ง|เลื่อน|ปรับ)\s*(?:เวลา|กำหนด(?:ส่ง)?|การเตือน|เตือน)?\s*งาน\s*(?:ที่\s*)?#?(\d{1,3})|^เตือนงาน\s*(?:ที่\s*)?#?(\d{1,3})/;

export function matchTaskEdit(text: string): number | null {
  const m = EDIT_RE.exec((text || "").trim());
  if (!m) return null;
  const n = Number(m[1] || m[2]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * เก็บทุกเวลาที่พูดถึงในประโยค
 *
 * ต้องได้หลายค่า เพราะ "เตือน 2 รอบ 16.00 กับ 17.00" คือสองรอบ ตัวแยกเวลาเดิม
 * (parseThaiClockToHHMM) คืนค่าเดียว จึงหยิบรูปแบบตัวเลขทั้งหมดก่อน แล้วค่อย
 * ตกไปใช้ตัวแยกภาษาไทยทีละท่อนถ้าไม่เจอเลข
 */
export function clockTimes(text: string, skip: number[] = []): string[] {
  const t = (text || "").replace(/\s+/g, " ");
  const found: string[] = [];

  for (const m of t.matchAll(/(\d{1,2})\s*[:.]\s*(\d{2})/g)) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h < 24 && mi < 60) found.push(`${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`);
  }

  if (!found.length) {
    /* ไม่มีรูปแบบ 16.00 — ลองภาษาพูดทีละท่อน "บ่าย 4 กับ 5 โมง"
       ตัดเลขที่รู้แล้วว่าเป็นเลขงาน/จำนวนรอบออกก่อน ไม่ให้กลายเป็นเวลา */
    let body = t;
    for (const n of skip) body = body.replace(new RegExp(`งาน\\s*(?:ที่\\s*)?#?${n}\\b`), " ");
    body = body.replace(/(\d{1,2})\s*รอบ/g, " ");
    for (const piece of body.split(/และ|กับ|,|รอบ\s*\d?|\//)) {
      const hhmm = parseThaiClockToHHMM(piece);
      if (hhmm) found.push(hhmm);
    }
  }

  return [...new Set(found)];
}

/** วันที่พูดถึงในประโยค — ไม่ระบุถือว่าวันนี้ */
function dayOffset(text: string): number {
  const t = text || "";
  if (/มะรืน|วันมะรืน/.test(t)) return 2;
  if (/พรุ่งนี้|พรุงนี้|พุ่งนี้/.test(t)) return 1;
  return 0;
}

export type TaskEditResult =
  | { ok: false; reply: string }
  | {
      ok: true;
      task: Task;
      due: string;
      alarms: string[];
      rolled: boolean;
      reply: string;
    };

/** งานค้างเรียงแบบเดียวกับการ์ด "งานที่ต้องติดตาม" */
export async function openTasks(upn: string): Promise<Task[]> {
  const all = await listTasks(upn);
  return all.filter((t) => t.status === "pending" || t.status === "overdue");
}

export async function applyTaskEdit(
  upn: string,
  index: number,
  text: string
): Promise<TaskEditResult> {
  const pending = await openTasks(upn);
  if (!pending.length) return { ok: false, reply: "ไม่มีงานติดตามค้างอยู่ครับ 👍" };

  const task = pending[index - 1];
  if (!task) {
    return {
      ok: false,
      reply: `ไม่มีงานลำดับที่ ${index} ครับ — ตอนนี้มีงานค้าง ${pending.length} รายการ พิมพ์ «ดูงานที่ต้องติดตาม» เพื่อดูเลขล่าสุดได้ครับ`,
    };
  }

  const times = clockTimes(text, [index]);
  if (!times.length) {
    return {
      ok: false,
      reply:
        `จะแก้เวลางาน «${task.title}» เป็นกี่โมงครับ\n\n` +
        `พิมพ์แบบนี้ได้เลย:\n` +
        `• «เปลี่ยนเวลางาน ${index} เป็น 16:00»\n` +
        `• «เตือนงาน ${index} 16:00 และ 17:00» — เตือนสองรอบ\n` +
        `• «เลื่อนงาน ${index} พรุ่งนี้ 09:00»`,
    };
  }

  /* เวลาที่ผ่านไปแล้วของวันนี้ ถือว่าหมายถึงวันพรุ่งนี้ — ไม่ทำแบบนี้ รอบเตือน
     ที่ตั้งไว้จะถึงกำหนดทันทีแล้วยิงออกในนาทีถัดไป ซึ่งไม่ใช่ที่ผู้ใช้ขอ */
  const base = startOfDay(addDays(nowWall(), dayOffset(text)));
  const now = nowWall().getTime();
  let rolled = false;
  const wall = times.map((hhmm) => {
    const [h, mi] = hhmm.split(":").map(Number);
    let d = new Date(base.getTime() + (h * 60 + mi) * 60_000);
    if (d.getTime() <= now && dayOffset(text) === 0) {
      d = addDays(d, 1);
      rolled = true;
    }
    return d;
  });
  wall.sort((a, b) => a.getTime() - b.getTime());

  const dueWall = wall[wall.length - 1];
  const dueIso = wallToUtcIso(dueWall);
  await updateTaskDue(task.id, dueIso);
  /* ย้ายกำหนดไปข้างหน้าแล้วสถานะต้องกลับเป็นค้างปกติ ไม่ใช่ "เกินกำหนด" ค้างไว้
     — ไม่งั้นการ์ดยังขึ้นเตือนสีแดงทั้งที่เพิ่งเลื่อนออกไป */
  if (task.status === "overdue") await updateTaskStatus(task.id, "pending");
  await setAlarms(upn, task.id, wall.map(wallToUtcIso));

  const when = (d: Date) => `${fmtDate(d)} ${fmtTime(d)}`;
  const lines = [
    `แก้เวลางานให้แล้วครับ ✅`,
    "",
    `${index}) ${task.title}`,
    `กำหนดส่ง: ${when(dueWall)}`,
  ];
  if (wall.length > 1) {
    lines.push(`เตือน ${wall.length} รอบ: ${wall.map((d) => fmtTime(d)).join(" และ ")}`);
  } else {
    lines.push(`เตือน: ${when(wall[0])}`);
  }
  if (rolled) lines.push("", "ℹ️ เวลาที่บอกผ่านไปแล้วของวันนี้ ผมตั้งเป็นวันพรุ่งนี้ให้ครับ");
  lines.push("", `เปลี่ยนใหม่ได้ตลอด พิมพ์ «เตือนงาน ${index} ...» อีกครั้งได้เลย`);

  return {
    ok: true,
    task,
    due: dueIso,
    alarms: wall.map(wallToUtcIso),
    rolled,
    reply: lines.join("\n"),
  };
}

/** ใช้ตอนอยากบอกผู้ใช้ว่างานนี้ตั้งเตือนไว้กี่โมง */
export function alarmLabel(iso: string): string {
  const w = utcIsoToWall(iso);
  return w ? `${fmtDate(w)} ${fmtTime(w)}` : iso;
}
