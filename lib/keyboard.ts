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
 * Fixes misspellings, inverted tone marks, and dropped consonants.
 */
export function normalizeThaiTypo(text: string): string {
  if (!text) return "";
  let s = text.normalize("NFC");

  // พรุ้งนี้ / วันพรุ้งนี้ / พุ่งนี้ / พรุ่งนี
  s = s.replace(/วันพรุ้[ง่]นี้/g, "วันพรุ่งนี้");
  s = s.replace(/พรุ้[ง่]นี้/g, "พรุ่งนี้");
  s = s.replace(/พุ่งนี้/g, "พรุ่งนี้");
  s = s.replace(/พรุ่งนี(?!\S)/g, "พรุ่งนี้");
  s = s.replace(/พรุ้ง(?!\S)/g, "พรุ่งนี้");

  // วันนี้ / วนนี้ / วันนี / วันีื้
  s = s.replace(/วันนี(?!\S)/g, "วันนี้");
  s = s.replace(/วัน[ีืิ]{1,2}้?/g, "วันนี้");
  s = s.replace(/วนนี้/g, "วันนี้");
  s = s.replace(/วันนี่/g, "วันนี้");

  // มะรืนนี้ / มะรืนนี / มารืนนี้ / มะรืนนื้
  s = s.replace(/มะรืนนี(?!\S)/g, "มะรืนนี้");
  s = s.replace(/มารืนนี้/g, "มะรืนนี้");
  s = s.replace(/มารืน/g, "มะรืน");
  s = s.replace(/มะรืนนื้/g, "มะรืนนี้");

  // เดือนหน้า / เดือนหน่า / เดือนหนา
  s = s.replace(/เดือนหน่[าาะ]/g, "เดือนหน้า");
  s = s.replace(/เดือนหนา(?!\S)/g, "เดือนหน้า");
  s = s.replace(/เดือนนี(?!\S)/g, "เดือนนี้");
  s = s.replace(/เดือนนี่/g, "เดือนนี้");

  // สัปดาห์หน้า / อาทิตย์หน้า / สัปดาห์นี้
  s = s.replace(/สัปดาห[์ิื]?(หน้?า|หน่?า)/g, "สัปดาห์หน้า");
  s = s.replace(/สัปดาห[์ิื]?(นี้|นี|นี่)/g, "สัปดาห์นี้");
  s = s.replace(/อาทิตย[์ิื]?(หน้?า|หน่?า)/g, "อาทิตย์หน้า");
  s = s.replace(/อาทิตย[์ิื]?(นี้|นี|นี่)/g, "อาทิตย์นี้");

  // ตาราง / ประชุม / นัด
  s = s.replace(/ตราราง/g, "ตาราง");
  s = s.replace(/ตารง/g, "ตาราง");
  s = s.replace(/ประชึม/g, "ประชุม");
  s = s.replace(/ประชม/g, "ประชุม");
  s = s.replace(/ปะชุม/g, "ประชุม");

  // งานค้าง / สรุป
  s = s.replace(/งานค่าง/g, "งานค้าง");
  s = s.replace(/งานค้างง+/g, "งานค้าง");

  // ว่างกี่โมง / ว่างไหม
  s = s.replace(/กี่โมงง+/g, "กี่โมง");
  s = s.replace(/กีโมง/g, "กี่โมง");
  s = s.replace(/ว่างไม(?!\S)/g, "ว่างไหม");
  s = s.replace(/ว่างมั้ย/g, "ว่างไหม");
  s = s.replace(/ว่างมัย/g, "ว่างไหม");

  // ช่วยเตรียม
  s = s.replace(/ช้วยเตรียม/g, "ช่วยเตรียม");

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
