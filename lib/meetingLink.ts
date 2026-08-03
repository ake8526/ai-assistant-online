// Link OneDrive files / URLs to a calendar meeting for later morning prep.
import { buildMorningAgenda, resolveAgendaEventId } from "@/lib/brief";
import { canAccessDriveItem, getEvent } from "@/lib/graph";
import {
  addMeetingMaterial,
  formatMaterialsList,
  getMeetingMaterials,
  listMeetingMaterials,
  removeMeetingMaterial,
  type MeetingMaterial,
} from "@/lib/meetingMaterials";

export type LinkCmdContext = {
  files?: { id?: string; name?: string; url?: string; is_folder?: boolean }[];
};

export type LinkCmdResult = {
  intent: string;
  reply: string;
  choices?: { index: number; event_id: string; label: string }[];
  suggestions?: { label: string; text: string }[];
};

function pickFile(
  files: LinkCmdContext["files"],
  fileIndex?: number
): { id?: string; name?: string; url?: string; is_folder?: boolean } | null {
  if (!files?.length) return null;
  const i = fileIndex && fileIndex >= 1 ? fileIndex - 1 : 0;
  return files[i] || null;
}

async function resolveEvent(
  upn: string,
  meetingIndex?: number,
  subject?: string
): Promise<{ eventId: string; subject: string; index?: number } | { ask: LinkCmdResult }> {
  const idx = Number(meetingIndex || 0);
  let eventId = idx ? await resolveAgendaEventId(upn, idx) : null;
  let subj = "";

  if (!eventId) {
    const agenda = await buildMorningAgenda(upn);
    if (subject) {
      const q = subject.toLowerCase();
      const hit = agenda.events.find((e) => (e.subject || "").toLowerCase().includes(q));
      if (hit?.id) {
        eventId = hit.id;
        subj = (hit.subject || "").trim();
      }
    }
    if (!eventId) {
      return {
        ask: {
          intent: "choose_link_meeting",
          reply:
            "บอกหมายเลขนัดที่จะผูกเอกสารด้วยครับ เช่น “ผูกไฟล์นัด 1” หรือ “แนบลิงก์นัด 2 https://…”\n\n" +
            agenda.text,
          choices: agenda.choices.map((c) => ({
            index: c.index,
            event_id: c.event_id,
            label: c.label,
          })),
        },
      };
    }
  }

  if (!subj && eventId) {
    try {
      const ev = await getEvent(upn, eventId);
      subj = (ev.subject || "").trim() || "นัดหมาย";
    } catch {
      subj = "นัดหมาย";
    }
  }
  return { eventId: eventId!, subject: subj || "นัดหมาย", index: idx || undefined };
}

export function quickLinkMeetingIntent(
  text: string
): { intent: string; params: Record<string, unknown> } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return null;

  // เลิกแนบนัด 1 ไฟล์ 2
  const unlink = t.match(
    /^(?:เลิก(?:ผูก|แนบ)|ถอด(?:ไฟล์|ลิงก์)?)\s*(?:กับ)?(?:นัด|ประชุม)\s*(?:หมายเลข|ที่|#)?\s*(\d+)(?:\s*(?:ไฟล์|ลิงก์|อัน|ข้อ)\s*(\d+))?$/i
  );
  if (unlink) {
    return {
      intent: "unlink_meeting_material",
      params: { meeting_index: Number(unlink[1]), item_index: unlink[2] ? Number(unlink[2]) : 1 },
    };
  }

  // เอกสารนัด 1 / ไฟล์ที่ผูกนัด 2
  const list = t.match(/^(?:เอกสาร|ไฟล์(?:ที่)?ผูก|ของ(?:ที่)?ผูก)\s*(?:นัด|ประชุม)\s*(?:หมายเลข|ที่|#)?\s*(\d+)$/i);
  if (list) return { intent: "list_meeting_materials", params: { meeting_index: Number(list[1]) } };

  // แนบลิงก์นัด 2 https://...
  const link = t.match(
    /^(?:ผูก|แนบ)\s*(?:ลิงก์|link|url)?\s*(?:กับ)?\s*(?:นัด|ประชุม)\s*(?:หมายเลข|ที่|#)?\s*(\d+)\s+(https?:\/\/\S+)/i
  );
  if (link) {
    return {
      intent: "link_meeting_url",
      params: { meeting_index: Number(link[1]), url: link[2].replace(/[)\].,;]+$/, "") },
    };
  }

  // ผูกไฟล์นัด 1 / แนบอัน 2 กับนัด 1 / ผูกไฟล์กับนัด 1
  const file = t.match(
    /^(?:ผูก|แนบ)\s*(?:ไฟล์)?\s*(?:อัน|ไฟล์|ข้อ)?\s*(\d+)?\s*(?:กับ)?\s*(?:นัด|ประชุม)\s*(?:หมายเลข|ที่|#)?\s*(\d+)$/i
  );
  if (file) {
    const a = file[1] ? Number(file[1]) : undefined;
    const b = Number(file[2]);
    // "ผูกไฟล์นัด 1" → only one number = meeting; "แนบอัน 2 กับนัด 1" → file + meeting
    if (file[1] && /อัน|ไฟล์|ข้อ/.test(t) && /กับ/.test(t)) {
      return { intent: "link_meeting_file", params: { file_index: a, meeting_index: b } };
    }
    if (file[1] && !file[2]) {
      return { intent: "link_meeting_file", params: { meeting_index: a } };
    }
    // ผูกไฟล์นัด 1 → meeting only (groups: optional file idx missing, meeting = group2)
    // Regex always has group2 as last number when "นัด N"
    return {
      intent: "link_meeting_file",
      params: file[1] && /อัน|ข้อ/.test(t) ? { file_index: a, meeting_index: b } : { meeting_index: b },
    };
  }

  // ผูกกับนัด 1 / แนบให้นัด 2 (หลังค้นไฟล์)
  const short = t.match(/^(?:ผูก|แนบ)(?:ไฟล์(?:นี้)?)?\s*(?:กับ|ให้)\s*(?:นัด|ประชุม)\s*(?:หมายเลข|ที่|#)?\s*(\d+)$/i);
  if (short) {
    return { intent: "link_meeting_file", params: { meeting_index: Number(short[1]), file_index: 1 } };
  }

  return null;
}

export async function handleLinkMeetingFile(
  upn: string,
  params: Record<string, unknown>,
  context?: LinkCmdContext
): Promise<LinkCmdResult> {
  const meetingIndex = Number(params.meeting_index || 0);
  const fileIndex = Number(params.file_index || 0) || undefined;
  const subject = String(params.subject || "").trim() || undefined;

  const resolved = await resolveEvent(upn, meetingIndex, subject);
  if ("ask" in resolved) return resolved.ask;

  const file = pickFile(context?.files, fileIndex);
  if (!file || file.is_folder) {
    return {
      intent: "link_meeting_file",
      reply:
        "ยังไม่มีไฟล์ให้ผูกครับ — พิมพ์ค้นก่อน เช่น “หาไฟล์งบ Q3” แล้วค่อยพิมพ์ “ผูกไฟล์นัด 1” หรือ “แนบอัน 2 กับนัด 1”",
      suggestions: [
        { label: "หาไฟล์", text: "หาไฟล์" },
        { label: "ตารางวันนี้", text: "ตารางวันนี้" },
      ],
    };
  }
  if (!file.id && !file.url) {
    return { intent: "link_meeting_file", reply: "ไฟล์นี้ไม่มีลิงก์/ไอดีใน OneDrive ครับ ลองค้นใหม่ได้ไหม" };
  }

  if (file.id) {
    const ok = await canAccessDriveItem(upn, file.id);
    if (!ok) {
      return {
        intent: "link_meeting_file",
        reply:
          `⚠️ บัญชีของคุณเข้าถึงไฟล์นี้ใน OneDrive ไม่ได้ครับ\n` +
          `📎 ${(file.name || file.url || "").trim()}\n\n` +
          `ขอสิทธิ์จากเจ้าของไฟล์ หรือใช้ไฟล์ที่อยู่ใน OneDrive ของคุณก่อน แล้วค่อยผูกกับนัด`,
      };
    }
  }

  await addMeetingMaterial(
    upn,
    resolved.eventId,
    {
      type: "file",
      id: file.id,
      name: file.name,
      url: file.url || "",
    },
    resolved.subject
  );

  const n = resolved.index || meetingIndex || "?";
  return {
    intent: "link_meeting_file",
    reply:
      `✅ ผูกไฟล์กับนัดแล้วครับ\n` +
      `📌 ${resolved.subject}\n` +
      `📎 ${(file.name || file.url || "").trim()}\n\n` +
      `ตอนเช้าหรือพิมพ์ “เตรียมนัด ${n}” ระบบจะอ่านไฟล์นี้ประกอบคำแนะนำให้ครับ`,
    suggestions: [
      { label: `เตรียมนัด ${n}`, text: `เตรียมนัด ${n}` },
      { label: `เอกสารนัด ${n}`, text: `เอกสารนัด ${n}` },
      { label: "หาไฟล์อื่น", text: "หาไฟล์" },
    ],
  };
}

export async function handleLinkMeetingUrl(
  upn: string,
  params: Record<string, unknown>
): Promise<LinkCmdResult> {
  const meetingIndex = Number(params.meeting_index || 0);
  const url = String(params.url || "").trim();
  const subject = String(params.subject || "").trim() || undefined;
  if (!/^https?:\/\//i.test(url)) {
    return { intent: "link_meeting_url", reply: "ส่งลิงก์แบบ https://… มาด้วยครับ เช่น “แนบลิงก์นัด 1 https://…”" };
  }

  const resolved = await resolveEvent(upn, meetingIndex, subject);
  if ("ask" in resolved) return resolved.ask;

  await addMeetingMaterial(
    upn,
    resolved.eventId,
    { type: "link", name: url, url },
    resolved.subject
  );

  const n = resolved.index || meetingIndex || "?";
  return {
    intent: "link_meeting_url",
    reply:
      `✅ ผูกลิงก์กับนัดแล้วครับ\n` +
      `📌 ${resolved.subject}\n` +
      `🔗 ${url}\n\n` +
      `พิมพ์ “เตรียมนัด ${n}” เพื่อให้ช่วยอ่านลิงก์นี้ด้วยครับ`,
    suggestions: [
      { label: `เตรียมนัด ${n}`, text: `เตรียมนัด ${n}` },
      { label: `เอกสารนัด ${n}`, text: `เอกสารนัด ${n}` },
    ],
  };
}

export async function handleListMeetingMaterials(
  upn: string,
  params: Record<string, unknown>
): Promise<LinkCmdResult> {
  const meetingIndex = Number(params.meeting_index || 0);
  const resolved = await resolveEvent(upn, meetingIndex, String(params.subject || "").trim() || undefined);
  if ("ask" in resolved) return resolved.ask;
  const { items } = await listMeetingMaterials(upn, resolved.eventId);
  const n = resolved.index || meetingIndex || "?";
  return {
    intent: "list_meeting_materials",
    reply: formatMaterialsList(resolved.subject, items),
    suggestions: items.length
      ? [
          { label: `เตรียมนัด ${n}`, text: `เตรียมนัด ${n}` },
          { label: `เลิกแนบนัด ${n} ไฟล์ 1`, text: `เลิกแนบนัด ${n} ไฟล์ 1` },
        ]
      : [
          { label: "หาไฟล์", text: "หาไฟล์" },
          { label: `ผูกไฟล์นัด ${n}`, text: `ผูกไฟล์นัด ${n}` },
        ],
  };
}

export async function handleUnlinkMeetingMaterial(
  upn: string,
  params: Record<string, unknown>
): Promise<LinkCmdResult> {
  const meetingIndex = Number(params.meeting_index || 0);
  const itemIndex = Number(params.item_index || 1);
  const resolved = await resolveEvent(upn, meetingIndex, String(params.subject || "").trim() || undefined);
  if ("ask" in resolved) return resolved.ask;
  const res = await removeMeetingMaterial(upn, resolved.eventId, itemIndex);
  if (!res.ok || !res.removed) {
    const items = await getMeetingMaterials(upn, resolved.eventId);
    return {
      intent: "unlink_meeting_material",
      reply:
        items.length
          ? `ไม่พบรายการที่ ${itemIndex} ครับ — มีทั้งหมด ${items.length} รายการ\n\n` +
            formatMaterialsList(resolved.subject, items)
          : `นัดนี้ยังไม่มีเอกสารที่ผูกไว้ครับ`,
    };
  }
  const removed: MeetingMaterial = res.removed;
  return {
    intent: "unlink_meeting_material",
    reply: `✅ เลิกผูกแล้วครับ: ${(removed.name || removed.url).trim()}`,
    suggestions: [{ label: `เอกสารนัด ${meetingIndex || ""}`.trim(), text: `เอกสารนัด ${meetingIndex}` }],
  };
}
