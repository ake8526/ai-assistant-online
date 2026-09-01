/**
 * ดีไซน์โน้ตแปะกระดาน — คลาสและชิ้นส่วนที่ทุกแท็บใช้ร่วมกัน
 *
 * หลักของดีไซน์: สีอยู่ใน "แผ่นโน้ต" ส่วนขอบกับเงาเป็นหมึกสีเดียวกันหมด
 * สีจึงเยอะได้โดยไม่ตีกัน เงาเป็นเงาแข็งไม่เบลอเหมือนกระดาษซ้อนกันจริง
 */

export const BOARD = "bg-[var(--nb-board)] text-[var(--nb-ink)] font-note";
export const NOTE = "border-2 border-[var(--nb-ink)] rounded-[14px] shadow-[3px_3px_0_var(--nb-ink)]";
export const NOTE_SM = "border-2 border-[var(--nb-ink)] rounded-[11px] shadow-[2px_2px_0_var(--nb-ink)]";

/** มุมพับขวาบน — ต้องใช้กับ element ที่พื้นหลังด้านหลังเป็นสีกระดาน */
export const FOLD =
  "relative rounded-tr-none before:content-[''] before:absolute before:-top-0.5 before:-right-0.5 " +
  "before:w-5 before:h-5 before:bg-[var(--nb-board)] before:border-l-2 before:border-b-2 " +
  "before:border-[var(--nb-ink)] before:rounded-bl-[5px]";

/** กดแล้วยุบลงไปทับเงา เหมือนกดกระดาษจริง */
export const PRESS =
  "active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-transform";

export const N_YELLOW = "bg-[var(--nb-yellow)]";
export const N_BLUE = "bg-[var(--nb-blue)]";
export const N_GREEN = "bg-[var(--nb-green)]";
export const N_PINK = "bg-[var(--nb-pink)]";
export const N_PURPLE = "bg-[var(--nb-purple)]";
export const N_ORANGE = "bg-[var(--nb-orange)]";

export const INK_2 = "text-[var(--nb-ink-2)]";
export const INK_3 = "text-[var(--nb-ink-3)]";

export const CHIP_TINTS = [N_BLUE, N_GREEN, N_PURPLE, N_PINK, N_ORANGE];

export function MicrosoftMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true" className="shrink-0">
      <rect x="1" y="1" width="9" height="9" rx="1" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" rx="1" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" rx="1" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" rx="1" fill="#ffb900" />
    </svg>
  );
}

/**
 * หน้าผู้ช่วย — หัวหุ่นยนต์ KTIS X ตัวเดียวกับหน้าเข้าสู่ระบบและไอคอนแอป
 *
 * ของเดิมเป็นหน้ายิ้มลายเส้นที่วาดเอง ซึ่งไม่เหมือนหุ่นยนต์ที่ผู้ใช้เห็นตอนเปิดแอป
 * เลย — ตัวละครในแอปควรเป็นตัวเดียวกันทุกที่ ภาพครอปมาจาก ktisx-robot.png
 * (สคริปต์ครอปหัวอยู่ในคอมมิตที่เพิ่มไฟล์นี้) พื้นเหลืองกับกรอบหมึกยังอยู่ตามเดิม
 * รูปจึงยังเป็น "โน้ตแปะ" กลืนกับที่เหลือของหน้าจอ
 */
export function AssistantFace({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 grid place-items-center overflow-hidden border-2 border-[var(--nb-ink)] rounded-[10px] ${N_YELLOW} -rotate-3 ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/ktisx-robot-head.png"
        alt=""
        className="w-full h-full object-contain scale-[1.06]"
        draggable={false}
      />
    </span>
  );
}

/** แผ่นโน้ตว่างที่ใช้บอกสถานะ เช่น ยังไม่มีข้อมูล / กำลังโหลด / ผิดพลาด */
export function BlankNote({ tint = N_YELLOW, children }: { tint?: string; children: React.ReactNode }) {
  return (
    <div className={`${NOTE} ${FOLD} ${tint} px-4 py-6 text-center font-hand text-[17px] -rotate-[0.5deg]`}>
      {children}
    </div>
  );
}

/** เรียก API ของเราด้วย token จริงของผู้ใช้ — ทุกแท็บใช้ตัวนี้ */
export async function authedGet<T>(
  path: string,
  getToken: () => Promise<string | null>,
  getGraphToken: () => Promise<string | null>
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("กรุณาเข้าสู่ระบบ Microsoft 365 ก่อนครับ");
  // ตอน dev getGraphToken() คืนค่าปลอม ("dev-graph-token") ถ้าส่งไปด้วย
  // ฝั่งเซิร์ฟเวอร์จะเอาไปยิง Graph แล้วพังทั้งที่มี token จริงเก็บไว้แล้ว
  const raw = (await getGraphToken()) || "";
  const graphToken = raw.includes(".") ? raw : "";
  const sep = path.includes("?") ? "&" : "?";
  const url = graphToken ? `${path}${sep}graphToken=${encodeURIComponent(graphToken)}` : path;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  /* 401 คือเซสชันใช้ไม่ได้แล้ว ไม่ใช่ข้อมูลผิด — ของเดิมโผล่ข้อความดิบของเซิร์ฟเวอร์
     ("Token validation failed: Invalid Compact JWS") ให้ผู้ใช้อ่านซึ่งไม่ได้บอกว่า
     ต้องทำอะไรต่อ */
  if (r.status === 401) throw new Error("เซสชันหมดอายุ — ออกจากระบบแล้วเข้าใหม่อีกครั้งครับ");
  return (await r.json()) as T;
}
