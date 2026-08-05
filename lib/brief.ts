// Morning brief / meeting-prep — agenda list first, then deep prep on demand.
import {
  GraphEvent,
  GraphAttachment,
  getEventsRange,
  getEvent,
  getEventAttachments,
  searchFiles,
  downloadDriveText,
} from "@/lib/graph";
import { chat } from "@/lib/llm";
import { getLineId, pushLineMessages } from "@/lib/line";
import { fetchArticle } from "@/lib/rss";
import { getMeetingMaterials } from "@/lib/meetingMaterials";
import { getSetting, setSetting } from "@/lib/store";
import { endOfDay, fmtHHMM, minutesOfDay, nowWall, parseWall, startOfDay, wallIso } from "@/lib/time";

const AGENDA_KEY = "_brief_agenda";

export type AgendaChoice = { index: number; event_id: string; label: string };

export type MorningAgenda = {
  text: string;
  events: GraphEvent[];
  choices: AgendaChoice[];
};

function keywordsFromSubject(subject: string): string {
  if (!subject) return "";
  const words = subject.match(/[\w\u0E00-\u0E7F]+/g) || [];
  const stop = new Set(["ประชุม", "meeting", "call", "sync", "review", "the", "and", "กับ", "เรื่อง"]);
  return words
    .filter((w) => !stop.has(w.toLowerCase()) && w.length > 1)
    .slice(0, 4)
    .join(" ");
}

function eventTimeRange(ev: GraphEvent): string {
  const sd = ev.start?.dateTime ? parseWall(ev.start.dateTime) : null;
  const ed = ev.end?.dateTime ? parseWall(ev.end.dateTime) : null;
  if (!sd) return "?";
  const a = fmtHHMM(minutesOfDay(sd));
  const b = ed ? fmtHHMM(minutesOfDay(ed)) : "";
  return b ? `${a}–${b}` : a;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  const clean = found.map((u) => u.replace(/[.,;:]+$/, ""));
  return Array.from(new Set(clean)).filter((u) => !/schemas\.microsoft|aka\.ms\/|teams\.microsoft\.com\/l\/meetup/i.test(u));
}

function decodeAttachmentText(att: GraphAttachment): string {
  if (!att.contentBytes) return "";
  const name = (att.name || "").toLowerCase();
  const ct = (att.contentType || "").toLowerCase();
  const textLike =
    ct.includes("text") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("html") ||
    /\.(txt|md|csv|json|html?|xml|log)$/i.test(name);
  if (!textLike) return "";
  try {
    const buf = Buffer.from(att.contentBytes, "base64");
    return buf.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 6000);
  } catch {
    return "";
  }
}

/** Format today's calendar as a numbered agenda (no LLM). */
export function formatAgendaList(
  events: GraphEvent[],
  periodLabel = "วันนี้",
  opts: { askPrep?: boolean } = {}
): string {
  const askPrep = opts.askPrep !== false;
  if (!events.length) {
    return `🌅 ตาราง${periodLabel}\n\nยังไม่มีนัดในปฏิทินครับ — พักผ่อนหรือจัดงานอื่นได้เลย 👍`;
  }
  const lines = [`🌅 ตาราง${periodLabel} — มี ${events.length} นัด`, ""];
  events.forEach((ev, i) => {
    const subj = (ev.subject || "(ไม่มีหัวข้อ)").trim();
    const who = ev.organizer?.emailAddress?.name || ev.organizer?.emailAddress?.address || "";
    const loc = ev.location?.displayName || (ev.onlineMeeting ? "ออนไลน์ (Teams)" : "");
    const people = (ev.attendees || [])
      .map((a) => a.emailAddress?.name || a.emailAddress?.address || "")
      .filter(Boolean)
      .slice(0, 4)
      .join(", ");
    lines.push(`${i + 1}) ${eventTimeRange(ev)} — ${subj}`);
    if (who) lines.push(`   ผู้จัด: ${who}`);
    if (loc) lines.push(`   สถานที่: ${loc}`);
    if (people) lines.push(`   ผู้เข้าร่วม: ${people}`);
    if (ev.bodyPreview?.trim()) lines.push(`   รายละเอียดย่อ: ${ev.bodyPreview.trim().slice(0, 120)}`);
    lines.push("");
  });
  if (askPrep) {
    lines.push("อยากให้ช่วยแนะนำเตรียมตัวนัดไหนดีครับ?");
    if (events.length === 1) {
      lines.push("กด «1» หรือพิมพ์ “แนะนำประชุม 1” เพื่อให้ช่วยเตรียมตัวนัดนี้");
    } else {
      lines.push(
        `กดหมายเลขด้านล่าง หรือพิมพ์ เช่น “แนะนำประชุม 1” / “เตรียมนัด ${Math.min(2, events.length)}”`
      );
    }
  }
  return lines.join("\n").trim();
}

export async function saveAgendaIds(upn: string, events: GraphEvent[]): Promise<void> {
  const now = nowWall();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const ids = events.map((e) => e.id).filter(Boolean) as string[];
  // Never wipe a good same-day agenda with an empty pull (false "ไม่มีนัด" would
  // break quick-reply "กด 1" → แนะนำประชุม).
  if (!ids.length) {
    const raw = await getSetting(upn, AGENDA_KEY);
    if (raw) {
      try {
        const prev = JSON.parse(raw) as { date?: string; ids?: string[] };
        if (prev.date === date && Array.isArray(prev.ids) && prev.ids.length) return;
      } catch {
        /* replace below */
      }
    }
  }
  await setSetting(upn, AGENDA_KEY, JSON.stringify({ date, ids }));
}

export async function resolveAgendaEventId(upn: string, index1: number): Promise<string | null> {
  const raw = await getSetting(upn, AGENDA_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { date?: string; ids?: string[] };
    const ids = parsed.ids || [];
    if (index1 < 1 || index1 > ids.length) return null;
    return ids[index1 - 1] || null;
  } catch {
    return null;
  }
}

/** List today's meetings + ask which one to prep. */
export async function buildMorningAgenda(userUpn: string, periodLabel = "วันนี้"): Promise<MorningAgenda> {
  const now = nowWall();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const dayStart = wallIso(startOfDay(now));
  const dayEnd = wallIso(endOfDay(now));

  let events = await getEventsRange(userUpn, dayStart, dayEnd);
  if (!events.length) {
    const { getTodayEvents } = await import("@/lib/graph");
    events = await getTodayEvents(userUpn);
  }
  // Delegated /me sometimes returns [] while app-only /users/{upn} still sees the day.
  if (!events.length) {
    try {
      const { runAsAppOnly } = await import("@/lib/graphAuth");
      events = await runAsAppOnly(() => getEventsRange(userUpn, dayStart, dayEnd));
    } catch {
      /* keep empty */
    }
  }
  // If live calendarView is empty but we already saved today's ids (e.g. false
  // empty pull), reload those events so "กด 1 → แนะนำประชุม" still works.
  if (!events.length) {
    const raw = await getSetting(userUpn, AGENDA_KEY);
    if (raw) {
      try {
        const prev = JSON.parse(raw) as { date?: string; ids?: string[] };
        if (prev.date === today && prev.ids?.length) {
          const recovered: GraphEvent[] = [];
          for (const id of prev.ids) {
            if (!id) continue;
            try {
              recovered.push(await getEvent(userUpn, id));
            } catch {
              /* skip missing */
            }
          }
          if (recovered.length) events = recovered;
        }
      } catch {
        /* ignore */
      }
    }
  }

  await saveAgendaIds(userUpn, events);
  const choices: AgendaChoice[] = events
    .filter((e) => e.id)
    .map((e, i) => ({
      index: i + 1,
      event_id: e.id!,
      label: `${eventTimeRange(e)} — ${(e.subject || "(ไม่มีหัวข้อ)").trim()}`.slice(0, 80),
    }));
  return {
    text: formatAgendaList(events, periodLabel),
    events,
    choices,
  };
}

/** @deprecated Prefer buildMorningAgenda — kept for callers that want the agenda text only. */
export async function buildForToday(userUpn: string): Promise<string> {
  return (await buildMorningAgenda(userUpn)).text;
}

/** List view for meetings (no “ask which to prep” footer). */
export async function buildForEvents(userUpn: string, events: GraphEvent[], periodLabel = "วันนี้"): Promise<string> {
  void userUpn;
  return formatAgendaList(events, periodLabel, { askPrep: false });
}

const PREP_SYSTEM = `คุณคือผู้ช่วยเตรียมประชุมส่วนตัว อ่านข้อมูลนัด + เนื้อหาอีเมล/ไฟล์แนบ/ลิงก์ที่ให้มา แล้วแนะนำเป็นภาษาไทยอย่างเป็นกันเอง ชัดเจน ใช้ได้จริง

รูปแบบคำตอบ:
1) บรรทัดแรก: 📌 สรุปสั้น ๆ ว่านัดนี้เกี่ยวกับอะไร (จากหัวข้อ + รายละเอียด)
2) 📄 สิ่งที่อ่านจากอีเมล/เอกสาร/ลิงก์ (สรุปประเด็นสำคัญเป็นข้อ ๆ — ถ้าไม่มีเอกสารให้บอกตรง ๆ)
3) ✅ ต้องเตรียม / ต้องทำก่อนเข้าประชุม
4) 💬 ในที่ประชุมควรพูด / ถาม / ชี้ประเด็นอะไรบ้าง (เป็นข้อ ๆ ปฏิบัติได้)
5) ⚠️ จุดที่ควรระวังหรือข้อมูลที่ยังขาด (ถ้ามี)

กติกา:
- ใช้เฉพาะข้อมูลที่มีในอินพุต ห้ามแต่งเอกสารที่ไม่มี
- ส่วน user_linked_materials คือเอกสาร/ลิงก์ที่ผู้ใช้ผูกกับนัดนี้เอง — ให้น้ำหนักสูงเมื่อสรุปและแนะนำ
- ถ้าเนื้อหาเอกสารน้อย ให้แนะนำจากหัวข้อ + รายละเอียดอีเมล + ผู้เข้าร่วมเท่าที่มี
- วันที่ใช้ DD/MM/YYYY เวลา HH:MM (24 ชม.)`;

/** Deep prep for one meeting: subject, email body, attachments, links, related files. */
export async function buildMeetingPrep(userUpn: string, eventId: string): Promise<string> {
  const ev = await getEvent(userUpn, eventId);
  const bodyHtml = ev.body?.content || "";
  const bodyText = stripHtml(bodyHtml).slice(0, 8000) || (ev.bodyPreview || "").trim();
  const urls = extractUrls(bodyHtml + "\n" + bodyText).slice(0, 5);

  const attachments = ev.hasAttachments ? await getEventAttachments(userUpn, eventId) : [];
  const attachmentNotes: { name: string; contentType?: string; excerpt?: string }[] = [];
  for (const att of attachments.slice(0, 8)) {
    if (att.isInline) continue;
    const name = att.name || "attachment";
    const excerpt = decodeAttachmentText(att);
    attachmentNotes.push({
      name,
      contentType: att.contentType,
      excerpt: excerpt || undefined,
    });
  }

  const linkNotes: { url: string; text: string }[] = [];
  for (const url of urls.slice(0, 3)) {
    const text = await fetchArticle(url);
    linkNotes.push({ url, text: text.slice(0, 4000) || "(ดึงเนื้อหาไม่ได้)" });
  }

  const query = keywordsFromSubject(ev.subject || "");
  const files = query ? (await searchFiles(userUpn, query)).slice(0, 5) : [];
  const fileNotes: { name?: string; webUrl?: string; excerpt?: string }[] = [];
  for (const f of files) {
    const note: { name?: string; webUrl?: string; excerpt?: string } = { name: f.name, webUrl: f.webUrl };
    const n = (f.name || "").toLowerCase();
    if (f.id && /\.(txt|md|csv|json|html?|xml|log)$/i.test(n)) {
      const excerpt = await downloadDriveText(userUpn, f.id);
      if (excerpt) note.excerpt = excerpt.slice(0, 4000);
    }
    fileNotes.push(note);
  }

  // User-linked materials (attached later via LINE/chat — not necessarily on the calendar event)
  const linked = await getMeetingMaterials(userUpn, eventId);
  const userLinked: {
    type: string;
    name?: string;
    url: string;
    excerpt?: string;
    access_note?: string;
  }[] = [];
  for (const m of linked.slice(0, 8)) {
    const row: {
      type: string;
      name?: string;
      url: string;
      excerpt?: string;
      access_note?: string;
    } = { type: m.type, name: m.name, url: m.url };
    if (m.type === "file" && m.id) {
      const n = (m.name || m.url || "").toLowerCase();
      if (/\.(txt|md|csv|json|html?|xml|log)$/i.test(n)) {
        try {
          const excerpt = await downloadDriveText(userUpn, m.id);
          if (excerpt) row.excerpt = excerpt.slice(0, 5000);
          else row.access_note = "อ่านเนื้อหาไฟล์ไม่ได้ (อาจไม่มีสิทธิ์หรือไม่ใช่ไฟล์ข้อความ)";
        } catch {
          row.access_note = "ไม่มีสิทธิ์เข้าถึงไฟล์นี้ใน OneDrive ของผู้ใช้";
        }
      } else {
        row.access_note = "ไฟล์ชนิดนี้ยังอ่านเนื้อหาอัตโนมัติไม่ได้ — แนะนำจากชื่อไฟล์/ลิงก์";
      }
    } else if (m.type === "link" && /^https?:\/\//i.test(m.url)) {
      try {
        const text = await fetchArticle(m.url);
        row.excerpt = text.slice(0, 5000) || undefined;
        if (!row.excerpt) row.access_note = "ดึงเนื้อหาลิงก์ไม่ได้";
      } catch {
        row.access_note = "ดึงเนื้อหาลิงก์ไม่ได้";
      }
    }
    userLinked.push(row);
  }

  const payload = {
    meeting: {
      subject: ev.subject,
      start: ev.start?.dateTime,
      end: ev.end?.dateTime,
      location: ev.location?.displayName,
      online: !!ev.onlineMeeting,
      organizer: ev.organizer?.emailAddress,
      attendees: (ev.attendees || []).map((a) => a.emailAddress).filter(Boolean).slice(0, 15),
      webLink: ev.webLink,
    },
    email_body: bodyText.slice(0, 6000),
    attachments: attachmentNotes,
    linked_pages: linkNotes,
    related_onedrive_files: fileNotes,
    user_linked_materials: userLinked,
  };

  return chat(PREP_SYSTEM, "ข้อมูลนัดประชุมและเอกสารที่เกี่ยวข้อง:\n" + JSON.stringify(payload, null, 2), {
    temperature: 0.3,
  });
}

/** Push morning agenda to LINE with numbered quick-replies (prep by index). */
export async function runForUser(userUpn: string, ready?: MorningAgenda): Promise<string> {
  const agenda = ready || (await buildMorningAgenda(userUpn));
  const lineId = await getLineId(userUpn);
  if (!lineId) throw new Error(`${userUpn} ยังไม่ได้เชื่อมบัญชี LINE`);

  const header = "🌅 สรุปตารางเช้า";
  const body = `${header}\n\n${agenda.text}`;

  if (!agenda.choices.length) {
    await pushLineMessages(lineId, [{ type: "text", text: body.slice(0, 4900) }]);
    return agenda.text;
  }

  const items = agenda.choices.slice(0, 12).map((c) => {
    const withId = `a=prep&i=${c.index}&id=${encodeURIComponent(c.event_id)}`;
    const data = withId.length <= 300 ? withId : `a=prep&i=${c.index}`;
    return {
      type: "action",
      action: {
        type: "postback",
        label: `${c.index}`,
        data,
        displayText: `แนะนำประชุม ${c.index}`.slice(0, 60),
      },
    };
  });

  await pushLineMessages(lineId, [
    {
      type: "text",
      text: body.slice(0, 4900),
      quickReply: { items },
    },
  ]);
  return agenda.text;
}
