// Morning brief / meeting-prep generation — ported from morning_brief/brief.py + llm.py.
import { GraphEvent, getEventsRange, searchFiles } from "@/lib/graph";
import { chat } from "@/lib/llm";
import { sendLine } from "@/lib/line";
import { endOfDay, nowWall, startOfDay, wallIso } from "@/lib/time";

function keywordsFromSubject(subject: string): string {
  if (!subject) return "";
  const words = subject.match(/[\w\u0E00-\u0E7F]+/g) || [];
  const stop = new Set(["ประชุม", "meeting", "call", "sync", "review", "the", "and", "กับ", "เรื่อง"]);
  return words
    .filter((w) => !stop.has(w.toLowerCase()) && w.length > 1)
    .slice(0, 4)
    .join(" ");
}

function slimEvent(ev: GraphEvent) {
  return {
    subject: ev.subject,
    start: ev.start?.dateTime,
    end: ev.end?.dateTime,
    location: ev.location?.displayName,
    organizer: ev.organizer?.emailAddress?.name,
    attendees: (ev.attendees || [])
      .map((a) => a.emailAddress?.name)
      .filter(Boolean)
      .slice(0, 10),
    is_online: !!ev.onlineMeeting,
    preview: (ev.bodyPreview || "").slice(0, 300),
  };
}

function systemPrompt(periodLabel: string): string {
  return `คุณคือผู้ช่วยส่วนตัวเชิงรุกที่ช่วยเตรียมตัวสำหรับการประชุม
ผู้ใช้จะให้ข้อมูลนัดหมาย (${periodLabel}) เป็น JSON พร้อมไฟล์ที่เกี่ยวข้องของแต่ละนัด
พูดคุยเป็นธรรมชาติ เป็นกันเอง เหมือนผู้ช่วยที่ใส่ใจ ไม่ใช่ตอบห้วน ๆ

รูปแบบคำตอบ (ภาษาไทย):
1. เปิดด้วยประโยคทักทาย/สรุปภาพรวมสั้น ๆ 1 บรรทัด (เช่น "ช่วงนี้มี 3 นัดครับ ที่ต้องเตรียมตัวหน่อยคือ...")
2. ไล่รายประชุม แต่ละนัด:
   📌 <DD/MM/YYYY เวลา HH:MM> — <หัวข้อ> (ผู้เข้าร่วมหลัก)
      • เตรียมตัว: สิ่งที่ควรเตรียม (อิงจากหัวข้อ/ผู้เข้าร่วม/ไฟล์)
      • ควรพูด/ถาม: ประเด็นสำคัญ 2-3 ข้อ
      • ไฟล์ที่เกี่ยว (ถ้ามี): ชื่อไฟล์ + ข้อเสนอว่าน่าทบทวน/ปรับอะไร
3. ปิดท้ายด้วย:
   🎯 โฟกัส${periodLabel}: 1-2 บรรทัด
   💡 ข้อเสนอเพิ่มเติม: คำแนะนำเชิงรุก 1-3 ข้อ เช่น ควรกันเวลาเตรียมตัวก่อนนัดไหน,
      ควรส่งวาระล่วงหน้า, นัดไหนซ้อน/ชิดกันควรระวัง, หรือควรเตรียมเอกสารอะไรเพิ่ม

กติกา:
- วันที่ทุกจุดให้ใช้รูปแบบ DD/MM/YYYY เสมอ (เช่น 30/07/2026) และเวลาแบบ 24 ชม. HH:MM
- ห้ามแต่งข้อมูลที่ไม่มีในอินพุต ใช้เฉพาะสิ่งที่ให้มา แต่ "ข้อเสนอเพิ่มเติม"
  ให้แนะนำเชิงปฏิบัติได้จากบริบทที่มี (เวลา/ผู้เข้าร่วม/ความถี่ของนัด)`;
}

/** Prep brief (prep + talking points + related files) for a set of events. No delivery. */
export async function buildForEvents(userUpn: string, events: GraphEvent[], periodLabel = "วันนี้"): Promise<string> {
  const meetings = [];
  for (const ev of events) {
    const slim = slimEvent(ev);
    const query = keywordsFromSubject(slim.subject || "");
    const files = query ? (await searchFiles(userUpn, query)).slice(0, 5) : [];
    meetings.push({ event: slim, files: files.map((f) => ({ name: f.name, webUrl: f.webUrl })) });
  }
  const payload = { user: userUpn, period: periodLabel, meetings };
  return chat(systemPrompt(periodLabel), "ข้อมูลนัดหมาย:\n" + JSON.stringify(payload, null, 2), {
    temperature: 0.3,
  });
}

export async function buildForToday(userUpn: string): Promise<string> {
  const now = nowWall();
  const events = await getEventsRange(userUpn, wallIso(startOfDay(now)), wallIso(endOfDay(now)));
  return buildForEvents(userUpn, events, "วันนี้");
}

/** Build and deliver one user's morning brief via LINE. Returns the brief text. */
export async function runForUser(userUpn: string): Promise<string> {
  const text = await buildForToday(userUpn);
  await sendLine(userUpn, "🌅 Morning Brief วันนี้", text);
  return text;
}
