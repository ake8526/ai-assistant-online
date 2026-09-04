// "ยังไม่มีครับ กำลังพัฒนา" — but answering the question that was asked.
//
// The old fallback said "ยังไม่เข้าใจคำสั่งนี้" to everything, which reads as
// "you typed it wrong" when the truth is usually "the system cannot do that
// yet". Someone asking about leave forms learns nothing from a list of
// calendar commands. Each topic below names the thing they asked for, says
// where it stands, and points at the nearest thing that does work today.
//
// Add a row when a new question comes up twice. Move a row out when the
// feature ships — a "coming soon" for something already shipped is worse than
// no answer at all.

export type NotYetAnswer = {
  /** what the person asked about, in their words */
  topic: string;
  reply: string;
  suggestions?: { label: string; text: string }[];
};

type Row = {
  key: string;
  topic: string;
  /** any of these in the message picks this row */
  match: RegExp;
  /** the nearest thing that already works, if there is one */
  instead?: string;
  suggestions?: { label: string; text: string }[];
};

const HELP_CHIPS = [
  { label: "📖 คู่มือคำสั่ง", text: "/ช่วยเหลือ" },
  { label: "ตารางวันนี้", text: "ตารางวันนี้" },
];

const ROWS: Row[] = [
  {
    key: "leave",
    topic: "การลา / ใบลา",
    // People ask for a day off in more words than "ลา": "ขอวันหยุด" reached
    // nothing at all and came back as "ยังไม่เข้าใจคำสั่งนี้", while the answer
    // for the very same question was already sitting in this row.
    // Bare "วันหยุด" stays out on purpose — it belongs to the weekend replies
    // and to the hr row's "วันหยุดบริษัท".
    // ภาษาไทยไม่มีช่องว่างคั่นคำ คำสั้น ๆ จึงไปโผล่กลางคำอื่นได้
    // "เปลี่ยนเวลางาน 2 ให้เตือน 2 รอบ" เคยได้คำตอบเรื่องใบลา เพราะ "เวลางาน"
    // มี "ลางาน" อยู่ข้างใน — ผู้ใช้ถามเรื่องแก้เวลางาน แต่ระบบตอบเรื่องการลา
    match:
      /(?:ใบ)?ลา(?:ป่วย|กิจ|พักร้อน|คลอด)|(?<!เว)ลางาน|ขอลา|ลากี่วัน|วันลา(?:คงเหลือ|เหลือ)?|โควตาลา|ขอวันหยุด|ขอหยุด(?:งาน|ยาว)?|ลาหยุด|วันหยุดพักผ่อน|หยุดพักร้อน/,
    instead: "กันเวลาในปฏิทินตัวเองได้ เช่น “จองตารางให้เราวันศุกร์นี้ทั้งวัน ลาพักร้อน”",
    suggestions: [{ label: "กันเวลาทั้งวัน", text: "จองตารางให้เราวันศุกร์นี้ทั้งวัน ลาพักร้อน" }],
  },
  {
    key: "payroll",
    topic: "เงินเดือน / สลิป",
    match: /สลิป(?:เงินเดือน)?|เงินเดือน|(?<!วิดี)โอที(?!วี)|ค่าล่วงเวลา|ภาษี\s*หัก|ประกันสังคม|กองทุนสำรอง/,
  },
  {
    key: "hr",
    topic: "งาน HR (ประวัติพนักงาน / สวัสดิการ)",
    match: /สวัสดิการ|ประวัติพนักงาน|ประเมินผล|KPI|ลงเวลา|ตอกบัตร|สแกนนิ้ว|วันหยุดบริษัท/,
  },
  // จองห้อง / ห้องว่าง — อย่าใส่ใน notYet: มี intent จริงแล้ว
  // (room_availability + find_meeting_time) ถ้าใส่ตรงนี้จะทับคำตอบที่ใช้ได้
  {
    key: "car",
    topic: "จองรถ / เบิกน้ำมัน",
    match: /จองรถ|รถส่วนกลาง|เบิกน้ำมัน|ขอใช้รถ|คนขับรถ/,
  },
  {
    key: "expense",
    topic: "เบิกจ่าย / จัดซื้อ",
    match: /เบิก(?:เงิน|ค่า)|ใบเสร็จ|เคลม|จัดซื้อ|PR\b|PO\b|ขออนุมัติซื้อ|วางบิล/,
  },
  {
    key: "itsupport",
    topic: "แจ้งซ่อม / ปัญหาไอที",
    match: /แจ้งซ่อม|คอมเสีย|ปริ๊นเตอร์|เน็ตช้า|เน็ตหลุด|ลืมรหัส|รีเซ็ตรหัส|ติดตั้งโปรแกรม|ขอ(?:สิทธิ์|ไลเซนส์)/,
    instead: "เรื่องนี้ต้องแจ้งทีม IT โดยตรงครับ ระบบยังไม่เปิดรับแจ้งซ่อมผ่านแชท",
  },
  {
    key: "mail",
    topic: "ส่ง / อ่านอีเมล",
    match: /ส่ง(?:อี)?เมล|เขียนเมล|ตอบเมล|อ่าน(?:อี)?เมล|inbox|กล่องจดหมาย/,
    instead: "อ่านรายละเอียดนัดจากอีเมลเชิญได้ ลองพิมพ์ “เตรียมนัด 1”",
    suggestions: [{ label: "เตรียมนัด 1", text: "เตรียมนัด 1" }],
  },
  {
    key: "doc",
    topic: "ร่างเอกสาร / แปลภาษา",
    match: /ร่าง(?:เอกสาร|จดหมาย|หนังสือ)|เขียนรายงานให้|ทำสไลด์ให้|แปล(?:ภาษา|ให้|เป็น)/,
    instead: "อ่านและสรุปไฟล์ที่มีอยู่ใน OneDrive ได้ ลองพิมพ์ “หาไฟล์ …” แล้ว “สรุปอัน 1”",
    suggestions: [{ label: "หาไฟล์ งบ Q3", text: "หาไฟล์ งบ Q3" }],
  },
  {
    key: "chatext",
    topic: "คุยกับลูกค้า / กลุ่ม LINE",
    match: /ส่งข้อความให้ลูกค้า|ตอบลูกค้า|กลุ่มไลน์|กลุ่ม\s*LINE|บรอดแคสต์|broadcast/i,
  },
  {
    key: "weather",
    topic: "สภาพอากาศ / ราคาหุ้น / เรื่องทั่วไป",
    match: /อากาศ(?:วันนี้|พรุ่งนี้)?|ฝนตก|ราคาหุ้น|ราคาทอง|อัตราแลกเปลี่ยน|หวย|ผลบอล/,
    instead: "ข่าวตามหัวข้อที่ติดตามไว้ทำได้ ลองพิมพ์ “ข่าววันนี้” หรือ “/ตั้งค่าข่าว”",
    suggestions: [{ label: "ข่าววันนี้", text: "ข่าววันนี้" }],
  },
];

/** "มีปัญหาต้องติดต่อใคร" — a person, not a feature. */
const CONTACT_RE =
  /ติดต่อ(?:ใคร|ที่ไหน|ยังไง|ได้ที่ไหน)|ถามใคร|แจ้ง(?:ใคร|ที่ไหน)|ใครดูแล|ผู้ดูแลระบบ|admin\s*ติดต่อ|support/i;

/**
 * Does this look like a question about something the assistant cannot do yet?
 * Returns null when it does not — the caller keeps its own fallback.
 */
export function notYetAnswer(text: string): NotYetAnswer | null {
  const t = (text || "").trim();
  if (!t) return null;

  if (CONTACT_RE.test(t)) {
    return {
      topic: "ติดต่อผู้ดูแล",
      reply: [
        "เรื่องระบบนี้ ติดต่อทีม IT ของ KTIS Group ได้เลยครับ 🛠️",
        "",
        "ถ้าเป็นเรื่องคำสั่งใช้งาน กดปุ่ม “คู่มือคำสั่ง” ด้านล่างดูก่อนได้",
        "เจอบั๊กหรืออยากให้เพิ่มความสามารถอะไร บอกในแชทนี้ไว้ได้ครับ ทีมงานเห็นย้อนหลังได้ทั้งหมด",
      ].join("\n"),
      suggestions: HELP_CHIPS,
    };
  }

  const hit = ROWS.find((r) => r.match.test(t));
  if (!hit) return null;

  const lines = [
    `เรื่อง${hit.topic} ยังทำไม่ได้ครับ 🚧`,
    "",
    "อยู่ในแผนพัฒนา — รออีกไม่นานครับ",
  ];
  if (hit.instead) lines.push("", `ตอนนี้ที่ช่วยได้ใกล้เคียงที่สุด: ${hit.instead}`);
  lines.push("", "อยากได้เรื่องนี้เร็วขึ้น บอกไว้ในแชทได้ครับ ทีมงานเห็นย้อนหลังได้");

  return {
    topic: hit.topic,
    reply: lines.join("\n"),
    suggestions: [...(hit.suggestions || []), ...HELP_CHIPS].slice(0, 4),
  };
}
