// LINE Rich Menu — 2×3 layout matching rich-menu-preview.html (draft B).
// Note: do NOT import sharp at top-level — webhook imports this module on every message.

export const RICH_MENU_NAME = "ktis-main-v5d-full";

/** Strip invisible chars LINE sometimes appends (ZWSP etc.) so menu taps match. */
export function sanitizeMenuText(text: string): string {
  return (text || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function settingsPageUrl(): string {
  const base = (process.env.NEXT_PUBLIC_APP_BASE_URL || "https://ktis-ai-assistant.vercel.app").replace(/\/$/, "");
  return `${base}/settings`;
}

const W = 2500;
const H = 1686; // full-size rich menu (ใหญ่กว่า compact 843)
const COL = Math.floor(W / 3); // 833
const ROW = Math.floor(H / 2); // 843
const COL3 = W - COL * 2; // 834
const ROW2 = H - ROW; // 843

export type RichMenuArea = {
  bounds: { x: number; y: number; width: number; height: number };
  action: { type: "message"; label: string; text: string };
};

export const RICH_MENU_AREAS: RichMenuArea[] = [
  {
    bounds: { x: 0, y: 0, width: COL, height: ROW },
    action: { type: "message", label: "ตารางจอง", text: "ตาราง·จอง" },
  },
  {
    bounds: { x: COL, y: 0, width: COL, height: ROW },
    action: { type: "message", label: "สรุปประชุม", text: "สรุปประชุม" },
  },
  {
    bounds: { x: COL * 2, y: 0, width: COL3, height: ROW },
    action: { type: "message", label: "สรุปข่าว", text: "ข่าววันนี้" },
  },
  {
    bounds: { x: 0, y: ROW, width: COL, height: ROW2 },
    action: { type: "message", label: "ไฟล์", text: "ไฟล์" },
  },
  // 「เร็วๆนี้」= visual only (no tap area) while travel is under development
  {
    bounds: { x: COL * 2, y: ROW, width: COL3, height: ROW2 },
    action: { type: "message", label: "ตั้งค่า", text: "ตั้งค่า" },
  },
];

export function richMenuObject() {
  return {
    size: { width: W, height: H },
    selected: true,
    name: RICH_MENU_NAME,
    chatBarText: "เมนู",
    areas: RICH_MENU_AREAS,
  };
}

function cellSvg(
  x: number,
  y: number,
  w: number,
  h: number,
  bg: string,
  iconBg: string,
  iconKind: "cal" | "meet" | "news" | "file" | "car" | "soon" | "gear",
  title: string,
  sub: string
): string {
  const cx = x + w / 2;
  // Soft panel fills nearly the whole cell; icon + labels sit inside it
  const pad = Math.round(Math.min(w, h) * 0.035);
  const panelX = x + pad;
  const panelY = y + pad;
  const panelW = w - pad * 2;
  const panelH = h - pad * 2;
  const panelRx = Math.round(Math.min(panelW, panelH) * 0.08);

  const glyph = Math.round(Math.min(panelW, panelH) * 0.38);
  const gy = panelY + Math.round(panelH * 0.1);
  const ix = cx - Math.round(glyph * 0.34);
  const iy = gy + Math.round(glyph * 0.12);
  const titleY = gy + glyph + Math.round(panelH * 0.14);
  const subY = titleY + Math.round(panelH * 0.1);
  const titleSize = Math.round(panelH * 0.115);
  const subSize = Math.round(panelH * 0.062);

  let icon = "";
  if (iconKind === "cal") {
    const iw = Math.round(glyph * 0.9);
    const ih = Math.round(glyph * 0.82);
    const lx = cx - iw / 2;
    icon = `<rect x="${lx}" y="${iy}" width="${iw}" height="${ih}" rx="18" fill="#0f766e"/>
      <rect x="${lx}" y="${iy}" width="${iw}" height="${Math.round(ih * 0.26)}" fill="#115e59"/>
      <rect x="${lx + iw * 0.12}" y="${iy + ih * 0.38}" width="${iw * 0.16}" height="${ih * 0.16}" fill="#ecfdf5"/>
      <rect x="${lx + iw * 0.4}" y="${iy + ih * 0.38}" width="${iw * 0.16}" height="${ih * 0.16}" fill="#ecfdf5"/>
      <rect x="${lx + iw * 0.68}" y="${iy + ih * 0.38}" width="${iw * 0.16}" height="${ih * 0.16}" fill="#ecfdf5"/>
      <rect x="${lx + iw * 0.12}" y="${iy + ih * 0.64}" width="${iw * 0.16}" height="${ih * 0.16}" fill="#a7f3d0"/>
      <rect x="${lx + iw * 0.4}" y="${iy + ih * 0.64}" width="${iw * 0.16}" height="${ih * 0.16}" fill="#a7f3d0"/>`;
  } else if (iconKind === "meet") {
    const r = Math.round(glyph * 0.2);
    icon = `<circle cx="${cx - r * 1.5}" cy="${iy + r * 1.5}" r="${r}" fill="#0f766e"/>
      <circle cx="${cx + r * 1.5}" cy="${iy + r * 1.5}" r="${r}" fill="#14b8a6"/>
      <circle cx="${cx}" cy="${iy + r * 3.5}" r="${r}" fill="#5eead4"/>
      <circle cx="${cx + r * 2.7}" cy="${iy + r * 3.5}" r="${r * 0.85}" fill="#99f6e4"/>`;
  } else if (iconKind === "news") {
    const iw = Math.round(glyph * 0.9);
    const ih = Math.round(glyph * 0.82);
    const lx = cx - iw / 2;
    icon = `<rect x="${lx}" y="${iy}" width="${iw}" height="${ih}" rx="16" fill="#0f766e"/>
      <rect x="${lx + iw * 0.14}" y="${iy + ih * 0.18}" width="${iw * 0.72}" height="${ih * 0.12}" fill="#ecfdf5"/>
      <rect x="${lx + iw * 0.14}" y="${iy + ih * 0.4}" width="${iw * 0.55}" height="${ih * 0.1}" fill="#a7f3d0"/>
      <rect x="${lx + iw * 0.14}" y="${iy + ih * 0.58}" width="${iw * 0.62}" height="${ih * 0.1}" fill="#a7f3d0"/>
      <rect x="${lx + iw * 0.14}" y="${iy + ih * 0.76}" width="${iw * 0.4}" height="${ih * 0.1}" fill="#a7f3d0"/>`;
  } else if (iconKind === "file") {
    const iw = Math.round(glyph * 0.72);
    const lx = cx - iw / 2;
    icon = `<path d="M${lx} ${iy} h${iw * 0.55} l${iw * 0.28} ${iw * 0.28} v${iw * 0.72} a16 16 0 0 1 -16 16 h-${iw * 0.7} a16 16 0 0 1 -16 -16 v-${iw * 0.88} a16 16 0 0 1 16 -16z" fill="#ea580c"/>
      <path d="M${lx + iw * 0.55} ${iy} v${iw * 0.28} h${iw * 0.28}" fill="#fb923c"/>
      <rect x="${lx + iw * 0.22}" y="${iy + iw * 0.55}" width="${iw * 0.55}" height="${iw * 0.09}" fill="#ffedd5"/>
      <rect x="${lx + iw * 0.22}" y="${iy + iw * 0.72}" width="${iw * 0.42}" height="${iw * 0.09}" fill="#ffedd5"/>`;
  } else if (iconKind === "car") {
    const iw = Math.round(glyph * 1.05);
    icon = `<rect x="${cx - iw / 2}" y="${iy + iw * 0.28}" width="${iw}" height="${iw * 0.38}" rx="16" fill="#2563eb"/>
      <path d="M${cx - iw * 0.32} ${iy + iw * 0.28} l${iw * 0.14} ${-iw * 0.2} h${iw * 0.36} l${iw * 0.14} ${iw * 0.2}" fill="#3b82f6"/>
      <circle cx="${cx - iw * 0.28}" cy="${iy + iw * 0.72}" r="${iw * 0.12}" fill="#1e3a8a"/>
      <circle cx="${cx + iw * 0.28}" cy="${iy + iw * 0.72}" r="${iw * 0.12}" fill="#1e3a8a"/>`;
  } else if (iconKind === "soon") {
    // Muted ellipsis — “coming soon”, no car
    const r = Math.round(glyph * 0.11);
    const cy = iy + Math.round(glyph * 0.42);
    const gap = Math.round(glyph * 0.32);
    icon = `<circle cx="${cx - gap}" cy="${cy}" r="${r}" fill="#94a3b8"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#64748b"/>
      <circle cx="${cx + gap}" cy="${cy}" r="${r}" fill="#94a3b8"/>
      <rect x="${cx - Math.round(glyph * 0.38)}" y="${cy + Math.round(glyph * 0.28)}" width="${Math.round(glyph * 0.76)}" height="${Math.round(glyph * 0.08)}" rx="6" fill="#cbd5e1"/>`;
  } else {
    const r = Math.round(glyph * 0.38);
    icon = `<circle cx="${cx}" cy="${iy + r * 1.05}" r="${r}" fill="none" stroke="#0f766e" stroke-width="${Math.round(r * 0.32)}"/>
      <circle cx="${cx}" cy="${iy + r * 1.05}" r="${r * 0.32}" fill="#0f766e"/>
      <rect x="${cx - r * 0.16}" y="${iy}" width="${r * 0.32}" height="${r * 0.36}" fill="#0f766e"/>
      <rect x="${cx - r * 0.16}" y="${iy + r * 1.75}" width="${r * 0.32}" height="${r * 0.36}" fill="#0f766e"/>
      <rect x="${cx - r * 1.25}" y="${iy + r * 0.88}" width="${r * 0.36}" height="${r * 0.32}" fill="#0f766e"/>
      <rect x="${cx + r * 0.9}" y="${iy + r * 0.88}" width="${r * 0.36}" height="${r * 0.32}" fill="#0f766e"/>`;
  }
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}"/>
  <rect x="${x + w - 3}" y="${y}" width="3" height="${h}" fill="#e5e7eb"/>
  <rect x="${x}" y="${y + h - 3}" width="${w}" height="3" fill="#e5e7eb"/>
  <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="${panelRx}" fill="${iconBg}"/>
  ${icon}
  <text x="${cx}" y="${titleY}" text-anchor="middle" font-size="${titleSize}" font-weight="700" fill="${iconKind === "soon" ? "#64748b" : "#111827"}" font-family="NotoThai, DejaVu Sans, Arial, sans-serif">${title}</text>
  <text x="${cx}" y="${subY}" text-anchor="middle" font-size="${subSize}" fill="${iconKind === "soon" ? "#94a3b8" : "#4b5563"}" font-family="NotoThai, DejaVu Sans, Arial, sans-serif">${sub}</text>`;
}

/** PNG buffer for LINE rich menu upload (≤1MB, 2500×1686 full). */
export async function buildRichMenuPng(opts?: { force?: boolean }): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const path = await import("path");
  const fs = await import("fs");

  // Prefer pre-rendered full-size asset (Thai fonts baked in).
  const staticPath = path.join(process.cwd(), "assets", "line-rich-menu.png");
  if (!opts?.force && fs.existsSync(staticPath)) {
    const existing = fs.readFileSync(staticPath);
    try {
      const meta = await sharp(existing).metadata();
      if (meta.width === W && meta.height === H) return existing;
    } catch {
      /* regenerate below */
    }
  }

  const os = await import("os");
  const fontsDir = path.join(process.cwd(), "assets", "fonts");
  const confPath = path.join(os.tmpdir(), `fontconfig-ktis-${process.pid}.conf`);
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${fontsDir.replace(/\\/g, "/")}</dir>
  <cachedir>${path.join(os.tmpdir(), "fontconfig-cache").replace(/\\/g, "/")}</cachedir>
</fontconfig>`;
  fs.writeFileSync(confPath, conf, "utf8");
  process.env.FONTCONFIG_FILE = confPath;

  const boldFile = path.join(fontsDir, "NotoSansThai-Bold.ttf").replace(/\\/g, "/");
  const regFile = path.join(fontsDir, "NotoSansThai-Regular.ttf").replace(/\\/g, "/");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style type="text/css">
      @font-face {
        font-family: 'NotoThai';
        src: url('file://${boldFile}');
        font-weight: 700;
      }
      @font-face {
        font-family: 'NotoThai';
        src: url('file://${regFile}');
        font-weight: 400;
      }
    </style>
  </defs>
  <rect width="${W}" height="${H}" fill="#f7f8f9"/>
  ${cellSvg(0, 0, COL, ROW, "#ffffff", "#e0f2f1", "cal", "ตาราง·จอง", "ติดตามนัด")}
  ${cellSvg(COL, 0, COL, ROW, "#ffffff", "#e0f2f1", "meet", "สรุปประชุม", "มอบหมายงาน")}
  ${cellSvg(COL * 2, 0, COL3, ROW, "#ffffff", "#e0f2f1", "news", "สรุปข่าว", "ที่ติดตาม")}
  ${cellSvg(0, ROW, COL, ROW2, "#fff7ed", "#ffedd5", "file", "ไฟล์", "ค้น·ผูก·แนบ")}
  ${cellSvg(COL, ROW, COL, ROW2, "#f1f5f9", "#e2e8f0", "soon", "เร็วๆนี้", "กำลังพัฒนา")}
  ${cellSvg(COL * 2, ROW, COL3, ROW2, "#ecfdf5", "#ccfbf1", "gear", "ตั้งค่า", "เปิดหน้าเว็บ")}
</svg>`;
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  try {
    fs.writeFileSync(staticPath, png);
  } catch {
    /* ignore on read-only fs */
  }
  return png;
}

function qrItems(labels: { label: string; text: string }[]) {
  return {
    items: labels.slice(0, 13).map((c) => ({
      type: "action",
      action: { type: "message", label: c.label.slice(0, 20), text: c.text },
    })),
  };
}

/**
 * Exact rich-menu tap texts → LINE reply messages (bypass LLM).
 * Returns null if text is not a rich-menu trigger.
 */
export function richMenuReply(text: string): object[] | null {
  const t = sanitizeMenuText(text);
  // Manager often uses ASCII hyphen; our artwork uses middle-dot ·
  const norm = t.replace(/[·•‧∙.\-–—_/]+/g, "").replace(/\s+/g, "");

  if (t === "ตาราง·จอง" || t === "ตารางจอง" || t === "ตาราง-จอง" || norm === "ตารางจอง") {
    return [
      {
        type: "text",
        text: "ตาราง · จอง · ติดตามนัด — เลือกได้เลยครับ",
        quickReply: qrItems([
          { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
          { label: "จองนัดใหม่", text: "จองนัด" },
          { label: "ตารางวันนี้", text: "ตารางวันนี้" },
          { label: "นัดพรุ่งนี้", text: "นัดพรุ่งนี้" },
        ]),
      },
    ];
  }

  if (t === "สรุปประชุม" || norm === "สรุปประชุม") {
    // Let handleCommand list past meetings with LINE quick-replies (do not intercept).
    return null;
  }

  if (t === "ไฟล์" || t === "ไฟล์·นัด" || t === "ไฟล์นัด" || t === "ไฟล์-นัด" || norm === "ไฟล์" || norm === "ไฟล์นัด") {
    return [
      {
        type: "text",
        text: "ไฟล์ — ค้น OneDrive / ผูกไฟล์ / แนบตอนจอง — เลือกได้เลยครับ",
        quickReply: qrItems([
          { label: "ค้นไฟล์ OneDrive", text: "หาไฟล์" },
          { label: "ผูกไฟล์กับนัด", text: "ผูกไฟล์นัด 1" },
          { label: "รายการไฟล์นัด", text: "ไฟล์ที่ผูกกับนัด" },
          { label: "เตรียมตัวนัด 1", text: "เตรียมตัวนัด 1" },
          { label: "สรุปตารางเช้า", text: "สรุปตารางเช้า" },
        ]),
      },
    ];
  }

  if (
    t === "เร็วๆนี้" ||
    norm === "เร็วๆนี้" ||
    t === "เร็วๆ นี้" ||
    t === "วางแผนเดินทาง" ||
    norm === "วางแผนเดินทาง" ||
    norm === "เดินทาง"
  ) {
    return [
      {
        type: "text",
        text:
          "🚧 เร็วๆนี้ — ฟีเจอร์วางแผนเดินทางกำลังอัปเกรดอยู่ครับ\n" +
          "เดี๋ยวเปิดให้ใช้พร้อมระบบใหม่ — ตอนนี้ใช้เมนูอื่นได้ตามปกติครับ",
      },
    ];
  }

  if (t === "ตั้งค่า" || norm === "ตั้งค่า") {
    const settingsUrl = settingsPageUrl();
    return [
      {
        type: "template",
        altText: "ตั้งค่า — เปิดหน้าเว็บหรือเลือกคำสั่ง",
        template: {
          type: "buttons",
          title: "ตั้งค่า",
          text: "เปิดหน้าเว็บ หรือเลือกคำสั่งจากเมนู /",
          actions: [
            { type: "uri", label: "เปิดหน้าตั้งค่าเว็บ", uri: settingsUrl },
            { type: "message", label: "ตั้งค่าข่าว", text: "ตั้งค่าข่าว" },
            { type: "message", label: "ตารางวันนี้", text: "/ตารางวันนี้" },
            { type: "message", label: "ช่วยเหลือ", text: "/ช่วยเหลือ" },
          ],
        },
      },
      {
        type: "text",
        text: "คำสั่งอื่น: /นัดพรุ่งนี้ · /ล้างความจำ · /ยกเลิก · สิทธิ์ปฏิทิน",
        quickReply: qrItems([
          { label: "/นัดพรุ่งนี้", text: "/นัดพรุ่งนี้" },
          { label: "/ล้างความจำ", text: "/ล้างความจำ" },
          { label: "/ยกเลิก", text: "/ยกเลิก" },
          { label: "/ตั้งค่าข่าว", text: "/ตั้งค่าข่าว" },
          { label: "สิทธิ์ปฏิทิน", text: "อนุญาตปฏิทิน" },
        ]),
      },
    ];
  }

  return null;
}

/** Map rich-menu / shortcut taps to a normal command string for handleCommand. */
export function richMenuRewrite(text: string): string | null {
  const t = sanitizeMenuText(text);
  if (t === "จองนัด") return "จองนัดประชุม";
  if (t === "หาไฟล์") return "หาไฟล์ใน OneDrive";
  if (t === "ไฟล์ที่ผูกกับนัด") return "ดูไฟล์ที่ผูกกับนัด";
  if (t === "อนุญาตปฏิทิน") return "ขอสิทธิ์ปฏิทิน";
  return null;
}
