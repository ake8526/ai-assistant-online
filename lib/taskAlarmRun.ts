/**
 * ส่งเตือนงานตามรอบที่ผู้ใช้ตั้งไว้ — เกาะไปกับ cron ตัวเตือนงาน
 *
 * แยกไฟล์จาก lib/taskAlarms.ts เพราะไฟล์นั้นเป็นที่เก็บข้อมูลล้วน ๆ ส่วนตัวนี้
 * ต้องดึง LINE, กล่องแจ้งเตือน และ trace เข้ามา — รวมไว้ไฟล์เดียวแล้วอะไรที่แค่
 * อยากอ่านค่าก็ต้องลากทั้งกองตามไปด้วย
 */

import { addNotice } from "@/lib/inbox";
import { getLineId, pushLineMessages, sendLine } from "@/lib/line";
import { listTasks } from "@/lib/store";
import { dueAlarms, dropClosed, markSent } from "@/lib/taskAlarms";
import { fmtDate, fmtTime, utcIsoToWall } from "@/lib/time";

function clock(iso: string): string {
  const wall = utcIsoToWall(iso);
  return wall ? `${fmtDate(wall)} ${fmtTime(wall)}` : iso;
}

export async function runTaskAlarms(): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const due = await dueAlarms();
  if (!due.length) return out;

  /* จัดกลุ่มตามคน แล้วอ่านงานของเขาครั้งเดียว — รอบเตือนหลายรอบของคนเดียวกัน
     ไม่ควรยิงอ่านตาราง tasks ซ้ำทุกรอบ */
  const byUser = new Map<string, typeof due>();
  for (const d of due) {
    if (!byUser.has(d.upn)) byUser.set(d.upn, []);
    byUser.get(d.upn)!.push(d);
  }

  const { runWithTrace, trace } = await import("@/lib/trace");
  for (const [upn, rounds] of byUser) {
    await dropClosed(upn).catch(() => 0);
    const tasks = await listTasks(upn);
    for (const r of rounds) {
      const task = tasks.find((t) => t.id === r.taskId);
      // ปิดไปแล้วหรือหายไป — dropClosed เก็บให้แล้ว ตรงนี้แค่ไม่ส่ง
      if (!task || (task.status !== "pending" && task.status !== "overdue")) {
        await markSent(upn, r.taskId, r.at).catch(() => {});
        out.skipped += 1;
        continue;
      }
      try {
        await runWithTrace({ upn, channel: "cron" }, async () => {
          trace("receive", "cron · เตือนงานตามเวลาที่ตั้งไว้");
          const body = `⏰ ถึงเวลาเตือนแล้วครับ\n\n${task.title}\nเวลา ${clock(r.at)}${
            task.due ? `\nกำหนดส่ง ${clock(task.due)}` : ""
          }`;
          await addNotice(upn, { kind: "task", title: "⏰ เตือนงาน", body }).catch(() => {});
          trace("compose", `งาน #${task.id}`);
          const lineId = await getLineId(upn);
          if (lineId) {
            await pushLineMessages(lineId, [
              {
                type: "text",
                text: body.slice(0, 4900),
                quickReply: {
                  items: [
                    {
                      type: "action",
                      action: { type: "message", label: "ปิดงานนี้", text: `ปิดงาน ${task.id}` },
                    },
                    {
                      type: "action",
                      action: { type: "message", label: "ดูงานค้าง", text: "ดูงานที่ต้องติดตาม" },
                    },
                  ],
                },
              },
            ]);
          } else {
            await sendLine(upn, "⏰ เตือนงาน", body);
          }
          trace("reply", "ส่งเตือน LINE");
        });
        await markSent(upn, r.taskId, r.at);
        out.sent += 1;
      } catch (e) {
        /* ส่งไม่ได้ (โควตาหมด/ยังไม่ผูกไลน์) — ไม่ mark ว่าส่งแล้ว รอบถัดไปลองใหม่
           แต่ต้องมีร่องรอยไว้ ไม่ใช่เงียบหาย */
        console.log(`[task-alarm] ${upn} #${r.taskId} ${r.at}: ${String(e).slice(0, 120)}`);
        out.failed += 1;
      }
    }
  }
  return out;
}
