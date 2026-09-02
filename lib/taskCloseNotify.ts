/**
 * บอกคนสั่งงานเมื่อคนที่รับงานปิดงานให้แล้ว
 *
 * เดิมวงจรการมอบงานขาดตรงปลาย: มอบงานได้ ระบบเตือนผู้รับให้เองทุกวัน
 * (lib/followup.ts recipientsFor) ผู้รับกดปิดจากปุ่มในข้อความเตือนได้ —
 * แต่ไม่มีอะไรวิ่งกลับไปบอกคนสั่ง เขาจึงต้องเปิดดูรายการเองถึงจะรู้ว่าเสร็จแล้ว
 * ซึ่งก็คือสิ่งที่การมอบงานควรจะช่วยให้ไม่ต้องทำ
 *
 * เข้ากล่องแจ้งเตือนในเว็บเสมอ (ไม่มีต้นทุน) ส่วน push เข้าไลน์ส่งเมื่อโควตายังเหลือ
 * — โควตา 300/เดือนใช้ร่วมกับบรีฟเช้าและการเตือนงาน หมดเมื่อไรคือทั้งระบบส่งไม่ได้
 * จึงไม่ยอมให้ข้อความ "งานปิดแล้ว" ไปเบียดของที่จำเป็นกว่า
 */
import { addNotice } from "@/lib/inbox";
import { getLineId, pushLineToId, pushQuotaGone } from "@/lib/line";
import type { Task } from "@/lib/store";

/** ชื่อที่คนสั่งงานจะอ่านรู้เรื่อง — ใช้ชื่อที่บันทึกไว้ตอนมอบงานก่อน แล้วค่อยถาม Graph */
async function closerName(closerUpn: string, tasks: Task[]): Promise<string> {
  const named = tasks.find(
    (t) => (t.responsible_upn || "").toLowerCase() === closerUpn.toLowerCase() && t.responsible
  );
  if (named?.responsible) return named.responsible;
  try {
    const { resolveUserInfo } = await import("@/lib/graph");
    const info = await resolveUserInfo(closerUpn);
    if (info?.displayName) return info.displayName;
  } catch {
    /* ไม่รู้ชื่อก็ยังต้องแจ้งได้ */
  }
  return closerUpn.split("@")[0] || closerUpn;
}

/**
 * แจ้งเจ้าของงานว่างานถูกปิดแล้ว — ข้ามงานที่เจ้าของปิดเอง
 * คืนจำนวนคนที่แจ้งไป (ไม่ throw: ปิดงานสำเร็จแล้วห้ามพังเพราะแจ้งไม่ได้)
 */
export async function notifyOwnerTasksClosed(closerUpn: string, tasks: Task[]): Promise<number> {
  const closer = (closerUpn || "").trim().toLowerCase();
  if (!closer || !tasks.length) return 0;

  const byOwner = new Map<string, Task[]>();
  for (const t of tasks) {
    const owner = (t.owner_upn || "").trim().toLowerCase();
    if (!owner || owner === closer) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner)!.push(t);
  }
  if (!byOwner.size) return 0;

  const who = await closerName(closer, tasks);
  let quotaGone = true;
  try {
    quotaGone = await pushQuotaGone();
  } catch {
    /* อ่านโควตาไม่ได้ก็ถือว่าไม่ควรเสี่ยงยิง */
  }

  let sent = 0;
  for (const [owner, list] of byOwner) {
    const titles = list.map((t) => `• ${t.title}`).join("\n");
    const body =
      `✅ ${who} ปิดงานที่คุณมอบไว้แล้ว ${list.length} งาน\n${titles}\n\n` +
      `พิมพ์ “งานที่มอบให้คนอื่น” เพื่อดูงานที่ยังเหลือครับ`;
    try {
      await addNotice(owner, { kind: "task", title: `${who} ปิดงานที่คุณมอบไว้`, body });
    } catch (e) {
      console.warn("[taskCloseNotify] addNotice", String(e).slice(0, 120));
    }
    if (quotaGone) continue;
    try {
      const lineId = await getLineId(owner);
      if (!lineId) continue;
      await pushLineToId(lineId, body);
      sent++;
    } catch (e) {
      console.warn("[taskCloseNotify] push", String(e).slice(0, 120));
    }
  }
  return sent;
}
