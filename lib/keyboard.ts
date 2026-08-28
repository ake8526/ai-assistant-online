// Thai Kedmanee <-> US QWERTY Keyboard Converter & Thai Typo Normalizer

const EN_TO_TH_MAP: Record<string, string> = {
  // Row 1
  "`": "_", "~": "%",
  "1": "ๅ", "!": "+",
  "2": "/", "@": "๑",
  "3": "-", "#": "๒",
  "4": "ภ", "$": "๓",
  "5": "ถ", "%": "๔",
  "6": "ุ", "^": "ู",
  "7": "ึ", "&": "฿",
  "8": "ค", "*": "๕",
  "9": "ต", "(": "๖",
  "0": "จ", ")": "๗",
  "-": "ข", "_": "๘",
  "=": "ช", "+": "๙",

  // Row 2
  "q": "ๆ", "Q": "๐",
  "w": "ไ", "W": "\"",
  "e": "ำ", "E": "ฎ",
  "r": "พ", "R": "ฑ",
  "t": "ะ", "T": "ธ",
  "y": "ั", "Y": "ํ",
  "u": "ี", "U": "๊",
  "i": "ร", "I": "ณ",
  "o": "น", "O": "ฯ",
  "p": "ย", "P": "ญ",
  "[": "บ", "{": "ฐ",
  "]": "ล", "}": ",",
  "\\": "ฃ", "|": "ฅ",

  // Row 3
  "a": "ฟ", "A": "ฤ",
  "s": "ห", "S": "ฆ",
  "d": "ก", "D": "ฏ",
  "f": "ด", "F": "โ",
  "g": "เ", "G": "ฌ",
  "h": "้", "H": "็",
  "j": "่", "J": "๋",
  "k": "า", "K": "ษ",
  "l": "ส", "L": "ศ",
  ";": "ว", ":": "ซ",
  "'": "ง", "\"": ".",

  // Row 4
  "z": "ผ", "Z": "(",
  "x": "ป", "X": ")",
  "c": "แ", "C": "ฉ",
  "v": "อ", "V": "ฮ",
  "b": "ิ", "B": "ฺ",
  "n": "ื", "N": "์",
  "m": "ท", "M": "?",
  ",": "ม", "<": "ฒ",
  ".": "ใ", ">": "ฬ",
  "/": "ฝ", "?": "ฦ",
  " ": " ",
};

const TH_TO_EN_MAP: Record<string, string> = {};
for (const [en, th] of Object.entries(EN_TO_TH_MAP)) {
  if (!TH_TO_EN_MAP[th]) {
    TH_TO_EN_MAP[th] = en;
  }
}

/** Convert string typed on US keyboard to Thai Kedmanee. */
export function convertEnToTh(text: string): string {
  return text
    .split("")
    .map((c) => EN_TO_TH_MAP[c] ?? c)
    .join("");
}

/** Convert string typed on Thai Kedmanee keyboard to US QWERTY. */
export function convertThToEn(text: string): string {
  return text
    .split("")
    .map((c) => TH_TO_EN_MAP[c] ?? c)
    .join("");
}

/**
 * Common Thai typos in assistant / calendar / task keywords.
 * Fixes misspellings, inverted tone marks, repeating letters, and dropped consonants.
 */
export function normalizeThaiTypo(text: string): string {
  if (!text) return "";
  let s = text.normalize("NFC");

  // 1. วลีที่มีหลายคำ (Multi-word phrases)
  s = s.replace(/วันพรุ[้่]?ง?น[ีืิึุูัะ็๊๋่้]{1,3}/g, "วันพรุ่งนี้");
  s = s.replace(/วันพุ[้่]?ง?น[ีืิึุูัะ็๊๋่้]{1,3}/g, "วันพรุ่งนี้");
  s = s.replace(/เมื่อ?วานน[ีืิึุูัะ็๊๋่้]{1,3}/g, "เมื่อวานนี้");
  s = s.replace(/เมือวานนี้/g, "เมื่อวานนี้");
  s = s.replace(/ช่างเช้า/g, "ช่วงเช้า");
  s = s.replace(/ช่วง\s*เข้า/g, "ช่วงเช้า");
  s = s.replace(/บลอกเวลา/g, "บล็อกเวลา");
  s = s.replace(/บล็อคเวลา/g, "บล็อกเวลา");
  s = s.replace(/บล๊อกเวลา/g, "บล็อกเวลา");
  s = s.replace(/บ๊อกเวลา/g, "บล็อกเวลา");
  s = s.replace(/มีไรบ้าง/g, "มีอะไรบ้าง");
  s = s.replace(/มีม[ัิีึืุูะั่้๊๋]*ย+/g, "มีไหม");
  s = s.replace(/มีไม(?!ค)/g, "มีไหม");
  s = s.replace(/มีปะ(?!ก|ด|น)/g, "มีไหม");
  s = s.replace(/มีป่าว/g, "มีไหม");
  s = s.replace(/ว่างม[ัิีึืุูะั่้๊๋]*ย+/g, "ว่างไหม");
  s = s.replace(/ว่างไม(?!ค)/g, "ว่างไหม");
  s = s.replace(/ว่างปะ/g, "ว่างไหม");
  s = s.replace(/ว่างป่าว/g, "ว่างไหม");
  s = s.replace(/ว่างเป่า/g, "ว่างไหม");
  s = s.replace(/ช้วยเตรียม/g, "ช่วยเตรียม");

  // 2. คำบอกวัน / เวลา / ช่วงเวลา (Day / Time / Period)
  // พรุ่งนี้ / วันนี้ / มะรืนนี้
  s = s.replace(/พรุ[้่]?ง?น[ีืิึุูัะ็๊๋่้]{1,3}/g, "พรุ่งนี้");
  s = s.replace(/พุ[้่]?ง?น[ีืิึุูัะ็๊๋่้]{1,3}/g, "พรุ่งนี้");
  s = s.replace(/วันน[ีืิึุูัะ็๊๋่้]{1,3}/g, "วันนี้");
  s = s.replace(/วนนี้/g, "วันนี้");
  s = s.replace(/วันเน้/g, "วันนี้");
  s = s.replace(/มะ[รล][ืิึุูั]{1,2}น?น?[ีืิึุูัะ็๊๋่้]{1,3}/g, "มะรืนนี้");
  s = s.replace(/มะลืน(?!น)/g, "มะรืน");
  s = s.replace(/มารืน(?!น)/g, "มะรืน");
  s = s.replace(/เมือวาน/g, "เมื่อวาน");

  // เช้า / บ่าย / เย็น / เที่ยง / ค่ำ
  s = s.replace(/เช้าน[ีืิึุูัะ็๊๋่้]{1,3}/g, "เช้านี้");
  s = s.replace(/ช่าวง/g, "ช่วง");
  s = s.replace(/เช้ส/g, "เช้า");
  s = s.replace(/บ่ายน[ีืิึุูัะ็๊๋่้]{1,3}/g, "บ่ายนี้");
  s = s.replace(/บ่ายย+นี้/g, "บ่ายนี้");
  s = s.replace(/เย็นน[ีืิึุูัะ็๊๋่้]{1,3}/g, "เย็นนี้");
  s = s.replace(/ค่ำน[ีืิึุูัะ็๊๋่้]{1,3}/g, "ค่ำนี้");
  s = s.replace(/เทียง/g, "เที่ยง");
  s = s.replace(/เที่ยงน[ีืิึุูัะ็๊๋่้]{1,3}/g, "เที่ยงนี้");
  s = s.replace(/ทั่งวัน/g, "ทั้งวัน");
  s = s.replace(/ทังวัน/g, "ทั้งวัน");

  // วันในสัปดาห์ (Days of Week)
  s = s.replace(/วันจัน(?!ท|ทร์|ทน์)/g, "วันจันทร์");
  s = s.replace(/วันจันทน์/g, "วันจันทร์");
  s = s.replace(/จันนี้/g, "จันทร์นี้");
  s = s.replace(/จันหน้า/g, "จันทร์หน้า");
  s = s.replace(/จันทร์น[ีืิึุูัะ็๊๋่้]{1,3}/g, "จันทร์นี้");
  s = s.replace(/วันอังคาน/g, "วันอังคาร");
  s = s.replace(/อังคาน/g, "อังคาร");
  s = s.replace(/อังคารน[ีืิึุูัะ็๊๋่้]{1,3}/g, "อังคารนี้");
  s = s.replace(/วันพุด/g, "วันพุธ");
  s = s.replace(/พุดนี้/g, "พุธนี้");
  s = s.replace(/พุดหน้า/g, "พุธหน้า");
  s = s.replace(/พุธน[ีืิึุูัะ็๊๋่้]{1,3}/g, "พุธนี้");
  s = s.replace(/วันพฤหัสบดี/g, "วันพฤหัส");
  s = s.replace(/พฤหัสบดี/g, "พฤหัส");
  s = s.replace(/พฤหัสส+/g, "พฤหัส");
  s = s.replace(/พฤหัสน[ีืิึุูัะ็๊๋่้]{1,3}/g, "พฤหัสนี้");
  s = s.replace(/วันศุก(?!ร|ร์)/g, "วันศุกร์");
  s = s.replace(/วันศุกร(?!์)/g, "วันศุกร์");
  s = s.replace(/วันสุก/g, "วันศุกร์");
  s = s.replace(/สุกนี้/g, "ศุกร์นี้");
  s = s.replace(/สุกหน้า/g, "ศุกร์หน้า");
  s = s.replace(/ศุกร์น[ีืิึุูัะ็๊๋่้]{1,3}/g, "ศุกร์นี้");
  s = s.replace(/วันเสา(?!ร|ร์)/g, "วันเสาร์");
  s = s.replace(/เสานี้/g, "เสาร์นี้");
  s = s.replace(/เสาหน้า/g, "เสาร์หน้า");
  s = s.replace(/เสาร์น[ีืิึุูัะ็๊๋่้]{1,3}/g, "เสาร์นี้");
  s = s.replace(/วันอาทิต(?!ย|ย์)/g, "วันอาทิตย์");
  s = s.replace(/อาทิตนี้/g, "อาทิตย์นี้");
  s = s.replace(/อาทิตหน้า/g, "อาทิตย์หน้า");
  s = s.replace(/อาทิตย์น[ีืิึุูัะ็๊๋่้]{1,3}/g, "อาทิตย์นี้");

  // สัปดาห์ / อาทิตย์ / เดือน
  s = s.replace(/สัปดาห[์ิื]?หน[า่้ะั]{1,2}/g, "สัปดาห์หน้า");
  s = s.replace(/สัปดาห[์ิื]?น[ีืิึุูัะ็๊๋่้]{1,3}/g, "สัปดาห์นี้");
  s = s.replace(/สัปดาหนี้/g, "สัปดาห์นี้");
  s = s.replace(/อาทิตย[์ิื]?หน[า่้ะั]{1,2}/g, "อาทิตย์หน้า");
  s = s.replace(/อาทิตย[์ิื]?น[ีืิึุูัะ็๊๋่้]{1,3}/g, "อาทิตย์นี้");
  s = s.replace(/เดือนหน[า่้ะั]{1,2}/g, "เดือนหน้า");
  s = s.replace(/เดือนน[ีืิึุูัะ็๊๋่้]{1,3}/g, "เดือนนี้");

  // ชื่อเดือน (Month Names)
  s = s.replace(/มกราคัม/g, "มกราคม");
  s = s.replace(/กุมภาพัน(?!ธ|ธ์)/g, "กุมภาพันธ์");
  s = s.replace(/พฤษาภาคม/g, "พฤษภาคม");
  s = s.replace(/กรกฏาคม/g, "กรกฎาคม");
  s = s.replace(/กรกฏา(?!ค)/g, "กรกฎา");
  s = s.replace(/พฤษาจิกายน/g, "พฤศจิกายน");
  s = s.replace(/พฤศจิกาฯ/g, "พฤศจิกายน");

  // 3. คำสั่งหลัก / กริยา (Commands / Verbs)
  // ตาราง / ปฏิทิน
  s = s.replace(/ตราราง/g, "ตาราง");
  s = s.replace(/ตารง/g, "ตาราง");
  s = s.replace(/ปฏิทินน์/g, "ปฏิทิน");
  s = s.replace(/ปฏิธิน/g, "ปฏิทิน");
  s = s.replace(/ปติทิน/g, "ปฏิทิน");

  // ประชุม / นัด
  s = s.replace(/ประชึม/g, "ประชุม");
  s = s.replace(/ประชม/g, "ประชุม");
  s = s.replace(/ปะชุม/g, "ประชุม");
  s = s.replace(/ปะชึม/g, "ประชุม");

  // ว่าง / กี่โมง
  s = s.replace(/กีโมง/g, "กี่โมง");

  // งานค้าง / สรุป
  s = s.replace(/งานค่าง/g, "งานค้าง");
  s = s.replace(/สรูป/g, "สรุป");
  s = s.replace(/สลุป/g, "สรุป");

  // ยกเลิก
  s = s.replace(/ยกเลิกก+/g, "ยกเลิก");
  s = s.replace(/แคนเซิล/g, "ยกเลิก");
  s = s.replace(/เเค้นเซิล/g, "ยกเลิก");

  // ข่าว / ฟีด
  s = s.replace(/แหลงข่าว/g, "แหล่งข่าว");
  s = s.replace(/ฟิด/g, "ฟีด");

  // เอกสาร / ไฟล์ / แผนที่
  s = s.replace(/ไฟล(?!์)/g, "ไฟล์");
  s = s.replace(/ฟายล์/g, "ไฟล์");
  s = s.replace(/แผนที(?!่)/g, "แผนที่");

  // 4. แก้ไขอักษรซ้ำท้ายคำ (Trailing repeated characters)
  s = s.replace(/ตารางง+/g, "ตาราง");
  s = s.replace(/ประชุมม+(?!ั|า)/g, "ประชุม");
  s = s.replace(/นัดด+/g, "นัด");
  s = s.replace(/นัดหมายย+/g, "นัดหมาย");
  s = s.replace(/งานค้างง+/g, "งานค้าง");
  s = s.replace(/สรุปป+(?!ร)/g, "สรุป");
  s = s.replace(/บรีฟฟ+/g, "บรีฟ");
  s = s.replace(/กี่โมงง+/g, "กี่โมง");
  s = s.replace(/กันเวลาา+/g, "กันเวลา");
  s = s.replace(/จองง+/g, "จอง");
  s = s.replace(/ติดตามม+/g, "ติดตาม");
  s = s.replace(/เอกสารร+/g, "เอกสาร");
  s = s.replace(/ช่วยเตรียมม+/g, "ช่วยเตรียม");

  return s;
}

/** Check if text looks like a keyboard-swapped message (e.g. English gibberish that converts to meaningful Thai). */
export function detectWrongKeyboard(text: string): {
  converted: string;
  direction: "en_to_th" | "th_to_en";
  isSlashCommand?: boolean;
} | null {
  const t = (text || "").trim();
  if (!t || t.length < 2) return null;

  // Case 1: Slash command typed with Thai keyboard: e.g. /ะำหะ (/test), /ืนให (/news), /สหททฟพั (/summary), /้ำสย (/help)
  if (t.startsWith("/")) {
    const rest = t.slice(1);
    const converted = convertThToEn(rest);
    if (/^[a-z0-9_-]+$/i.test(converted) && converted !== rest) {
      return { converted: `/${converted}`, direction: "th_to_en", isSlashCommand: true };
    }
  }

  // Case 2: Thai typed with English keyboard (e.g. rit'sub;jk'yDu,i -> พรุ่งนี้ว่างกี่โมง, 9kik';yOmn -> ตารางวันนี้, 'ko8hk' -> งานค้าง)
  // Check if string is mainly English ASCII and punctuation without actual English words
  const isAllAscii = /^[\x20-\x7E]+$/.test(t);
  const hasThai = /[\u0E00-\u0E7F]/.test(t);

  // If text already has Thai, it's not a purely swapped English layout
  if (isAllAscii && !hasThai) {
    // Exclude common real English messages or URLs/emails
    if (/https?:\/\/|@|^\/?(test|help|news|agenda|brief|summary|reset|clear)\b/i.test(t)) {
      return null;
    }
    const converted = convertEnToTh(t);
    const normalized = normalizeThaiTypo(converted);

    // Check if converted text contains key Thai assistant vocabulary
    const thaiKeyPattern = /(?:ตาราง|ประชุม|นัด|ว่าง|กี่โมง|พรุ่งนี้|วันนี้|มะรืน|สัปดาห์|เดือนหน้า|เดือนนี้|งานค้าง|สรุป|ข่าว|เตือน|ช่วย|ยกเลิก|จอง|เวลา|ใคร|อะไร|ไหม|มั้ย)/u;
    if (thaiKeyPattern.test(normalized)) {
      return { converted: normalized, direction: "en_to_th" };
    }
  }

  // Case 3: English command typed on Thai keyboard (e.g. ะำหะ -> test)
  if (hasThai && !isAllAscii) {
    const converted = convertThToEn(t);
    const knownEnCommands = /^(?:test|summary|news|agenda|brief|help|tasks|meetings|avail|availability|status|reset|clear|ping|start)$/i;
    if (knownEnCommands.test(converted.trim())) {
      return { converted: converted.trim(), direction: "th_to_en" };
    }
  }

  return null;
}

/** Check if a name has a close colleague nickname typo and suggest the right name. */
export function suggestCorrectedNick(name: string): string | null {
  const n = (name || "").trim();
  if (/^แบ[น]?ค์$/i.test(n) || /^แบค$/i.test(n) || /^แบ็ค$/i.test(n) || /^แบก์$/i.test(n) || /^แบค์$/i.test(n) || /^แบ้ง$/i.test(n)) {
    return "แบงค์";
  }
  if (/^เบส[ทสศ]$/i.test(n) || /^เบท$/i.test(n) || /^บส$/i.test(n)) {
    return "เบส";
  }
  if (/^นน[ท]$/i.test(n) || /^นันท์$/i.test(n) || /^นท์$/i.test(n)) {
    return "นนท์";
  }
  if (/^เอม[มี่ส์]?$/i.test(n)) {
    return "เอ็ม";
  }
  if (/^เอ๊ก|เอ็ก|เอกก์|เอ้ก$/i.test(n)) {
    return "เอก";
  }
  if (/^บ็อม|บ๋อม|บอมบ์$/i.test(n)) {
    return "บอม";
  }
  if (/^บอน$/i.test(n)) {
    return "บอล";
  }
  return null;
}
