// Meeting Room Directory for Microsoft 365 / Exchange Room Mailboxes
export interface MeetingRoom {
  email: string;
  name: string;
  displayName: string;
  aliases: string[];
}

export const KNOWN_MEETING_ROOMS: MeetingRoom[] = [
  {
    email: "ktisx_room_fl3@ktisgroup.com",
    name: "ห้อง KTISX (ชั้น 3)",
    displayName: "ห้อง KTISX ชั้น 3 (ktisx_room_fl3@ktisgroup.com)",
    aliases: [
      "ktisx",
      "ktis x",
      "ห้องktisx",
      "ห้อง ktisx",
      "ห้องประชุมktisx",
      "ห้องประชุม ktisx",
      "ktisx_room_fl3",
      "ktisx room",
      "ktisx_room",
      "ห้อง ktisx ชั้น 3",
      "ห้องktisxชั้น3",
    ],
  },
];

/** Check if text contains a reference to a known meeting room. */
export function findRoomByText(text: string): MeetingRoom | null {
  const t = (text || "").toLowerCase().trim();
  for (const r of KNOWN_MEETING_ROOMS) {
    if (r.aliases.some((a) => t.includes(a.toLowerCase()))) {
      return r;
    }
  }
  return null;
}

/** Check if an email belongs to a known meeting room. */
export function isMeetingRoomEmail(email: string): boolean {
  const e = (email || "").toLowerCase().trim();
  return KNOWN_MEETING_ROOMS.some((r) => r.email.toLowerCase() === e);
}

/** Get room display name by email. */
export function getRoomDisplayName(email: string): string {
  const e = (email || "").toLowerCase().trim();
  const found = KNOWN_MEETING_ROOMS.find((r) => r.email.toLowerCase() === e);
  return found ? `🏢 ${found.name}` : email;
}
