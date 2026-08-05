// Link OneDrive files / URLs to a calendar meeting for later morning prep.
import { buildMorningAgenda, resolveAgendaEventId } from "@/lib/brief";
import { canAccessDriveItem, getEvent, pushMaterialToOutlookEvent, searchFiles } from "@/lib/graph";
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
  files?: { id?: string; name?: string; url?: string; is_folder?: boolean }[];
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

function thaiOrdinalToIndex(s: string): number | null {
  const t = s.trim();
  if (/^(แรก|ที่\s*1|อัน\s*1|1)$/i.test(t)) return 1;
  if (/^(สอง|ที่\s*2|อัน\s*2|2)$/i.test(t)) return 2;
  if (/^(สาม|ที่\s*3|อัน\s*3|3)$/i.test(t)) return 3;
  if (/^(สี่|ที่\s*4|อัน\s*4|4)$/i.test(t)) return 4;
  if (/^(ห้า|ที่\s*5|อัน\s*5|5)$/i.test(t)) return 5;
  const m = t.match(/(\d+)/);
  return m ? Number(m[1]) : null;
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

/** Prefer exact filename match, then extension match, else first hit. */
function pickBestSearchHit(
  hits: { id?: string; name?: string; webUrl?: string; folder?: unknown }[],
  query: string
): { id?: string; name?: string; url?: string; is_folder?: boolean } | null {
  const files = hits.filter((h) => !h.folder);
  if (!files.length) return null;
  const q = query.trim().toLowerCase();
  const base = q.replace(/\.[a-z0-9]{1,8}$/i, "");
  const exact = files.find((f) => (f.name || "").toLowerCase() === q);
  const ends = files.find((f) => (f.name || "").toLowerCase().endsWith(q));
  const contains = files.find((f) => {
    const n = (f.name || "").toLowerCase();
    return n.includes(q) || (base.length >= 4 && n.includes(base));
  });
  const hit = exact || ends || contains || files[0]!;
  return { id: hit.id, name: hit.name, url: hit.webUrl, is_folder: false };
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

  // อันแรกผูกกับ ไฟล์xxx.html  /  นัด 1 ผูกกับ ฟังก์ชัน….html
  const named =
    t.match(
      /^(?:อัน|นัด|ประชุม|ข้อ)?\s*(แรก|สอง|สาม|สี่|ห้า|\d+)\s*(?:ผูก|แนบ)(?:กับ|ให้)?\s*(?:ไฟล์)?\s*(.+)$/i
    ) ||
    t.match(
      /^(?:ผูก|แนบ)\s*(?:ไฟล์)?\s*(.+?)\s*(?:กับ|ให้)\s*(?:นัด|ประชุม|อัน)\s*(?:หมายเลข|ที่|#)?\s*(แรก|\d+)$/i
    );
  if (named) {
    // form A: (ordinal)(filename)  form B: (filename)(ordinal)
    let meetingIndex: number | null = null;
    let fileQuery = "";
    if (/^(?:อัน|นัด|ประชุม|ข้อ)?\s*(แรก|สอง|สาม|สี่|ห้า|\d+)\s*(?:ผูก|แนบ)/i.test(t)) {
      meetingIndex = thaiOrdinalToIndex(named[1] || "");
      fileQuery = (named[2] || "").trim();
    } else {
      fileQuery = (named[1] || "").trim();
      meetingIndex = thaiOrdinalToIndex(named[2] || "");
    }
    fileQuery = fileQuery
      .replace(/^(?:กับ|ไฟล์)\s+/i, "")
      .replace(/[“”"']/g, "")
      .trim();
    if (meetingIndex && fileQuery && fileQuery.length >= 2) {
      return {
        intent: "link_meeting_file",
        params: { meeting_index: meetingIndex, file_query: fileQuery },
      };
    }
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
  const fileQuery = String(params.file_query || params.file_name || params.query || "").trim();

  const resolved = await resolveEvent(upn, meetingIndex, subject);
  if ("ask" in resolved) return resolved.ask;

  let file = pickFile(context?.files, fileIndex);
  let searchedFiles: LinkCmdResult["files"];

  // Named file / SharePoint URL in the same message → resolve immediately
  if ((!file || file.is_folder) && fileQuery) {
    const hits = await searchFiles(upn, fileQuery, 20);
    const best = pickBestSearchHit(hits, fileQuery);
    if (!best) {
      const stem = fileQuery.replace(/\.[a-z0-9]{1,8}$/i, "");
      return {
        intent: "link_meeting_file",
        reply:
          `หาไฟล์ “${fileQuery}” ใน OneDrive ยังไม่เจอครับ\n` +
          `ลองส่งลิงก์จาก OneDrive มาเลย (Share → Copy link) หรือพิมพ์ “หาไฟล์ ${stem}”`,
        suggestions: [
          { label: `หาไฟล์ ${stem}`.slice(0, 20), text: `หาไฟล์ ${stem}` },
          { label: "ตารางวันนี้", text: "ตารางวันนี้" },
        ],
      };
    }
    file = best;
    searchedFiles = hits
      .filter((h) => !h.folder)
      .slice(0, 5)
      .map((h) => ({ id: h.id, name: h.name, url: h.webUrl, is_folder: false }));
  }

  if (!file || file.is_folder) {
    return {
      intent: "link_meeting_file",
      reply:
        "ยังไม่มีไฟล์ให้ผูกครับ — บอกชื่อไฟล์มาเลยได้ เช่น “อันแรกผูกกับ งบ Q3.xlsx” หรือค้นก่อนด้วย “หาไฟล์…”",
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

  let outlookNote = "";
  try {
    const pushed = await pushMaterialToOutlookEvent(upn, resolved.eventId, {
      name: file.name,
      url: file.url || "",
      driveItemId: file.id,
    });
    outlookNote = pushed.note;
  } catch (e) {
    console.warn("[meetingLink] outlook push failed:", String(e).slice(0, 160));
    outlookNote = "อัปเดต Outlook ไม่สำเร็จ (ยังผูกให้ AI อ่านได้)";
  }

  const n = resolved.index || meetingIndex || "?";
  return {
    intent: "link_meeting_file",
    files: searchedFiles,
    reply:
      `✅ แนบไฟล์เข้า Outlook แล้วครับ\n` +
      `📌 ${resolved.subject}\n` +
      `📎 ${(file.name || file.url || "").trim()}\n` +
      (outlookNote ? `📬 ${outlookNote}\n` : "") +
      `\nผู้เข้าร่วมจะเห็นในนัด Outlook / Teams\n` +
      `พิมพ์ “เตรียมนัด ${n}” เพื่อให้ AI อ่านไฟล์นี้ด้วยได้ครับ`,
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

  let outlookNote = "";
  try {
    const pushed = await pushMaterialToOutlookEvent(upn, resolved.eventId, { name: url, url });
    outlookNote = pushed.note;
  } catch (e) {
    console.warn("[meetingLink] outlook link push failed:", String(e).slice(0, 160));
    outlookNote = "อัปเดต Outlook ไม่สำเร็จ (ยังผูกให้ AI อ่านได้)";
  }

  const n = resolved.index || meetingIndex || "?";
  return {
    intent: "link_meeting_url",
    reply:
      `✅ ใส่ลิงก์ในนัด Outlook แล้วครับ\n` +
      `📌 ${resolved.subject}\n` +
      `🔗 ${url}\n` +
      (outlookNote ? `📬 ${outlookNote}\n` : "") +
      `\nพิมพ์ “เตรียมนัด ${n}” เพื่อให้ AI อ่านลิงก์นี้ด้วยได้ครับ`,
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
