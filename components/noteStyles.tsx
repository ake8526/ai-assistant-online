/**
 * ดีไซน์โน้ตแปะกระดาน — คลาสและชิ้นส่วนที่ทุกแท็บใช้ร่วมกัน
 *
 * หลักของดีไซน์: สีอยู่ใน "แผ่นโน้ต" ส่วนขอบกับเงาเป็นหมึกสีเดียวกันหมด
 * สีจึงเยอะได้โดยไม่ตีกัน เงาเป็นเงาแข็งไม่เบลอเหมือนกระดาษซ้อนกันจริง
 */

export const BOARD = "bg-[#f1efe9] text-[#232122] font-note";
export const NOTE = "border-2 border-[#232122] rounded-[14px] shadow-[3px_3px_0_#232122]";
export const NOTE_SM = "border-2 border-[#232122] rounded-[11px] shadow-[2px_2px_0_#232122]";

/** มุมพับขวาบน — ต้องใช้กับ element ที่พื้นหลังด้านหลังเป็นสีกระดาน */
export const FOLD =
  "relative rounded-tr-none before:content-[''] before:absolute before:-top-0.5 before:-right-0.5 " +
  "before:w-5 before:h-5 before:bg-[#f1efe9] before:border-l-2 before:border-b-2 " +
  "before:border-[#232122] before:rounded-bl-[5px]";

/** กดแล้วยุบลงไปทับเงา เหมือนกดกระดาษจริง */
export const PRESS =
  "active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-transform";

export const N_YELLOW = "bg-[#fef2c0]";
export const N_BLUE = "bg-[#dcebfe]";
export const N_GREEN = "bg-[#d6f5e3]";
export const N_PINK = "bg-[#ffdee7]";
export const N_PURPLE = "bg-[#eae1ff]";
export const N_ORANGE = "bg-[#ffe7ce]";

export const INK_2 = "text-[#6a6560]";
export const INK_3 = "text-[#9c968e]";

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

/** หน้ายิ้มของผู้ช่วย — เส้นเดียวกับไอคอนแอป */
export function AssistantFace({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={`shrink-0 border-2 border-[#232122] rounded-[10px] ${N_YELLOW} p-0.5 -rotate-3 ${className}`}
    >
      <g fill="none" stroke="#232122" strokeWidth="2" strokeLinecap="round">
        <path d="M11.4 15 L11.4 17" />
        <path d="M20.6 14.9 L20.6 16.9" />
        <path d="M12 21.6 C14.4 24.2 18.4 24.2 20.4 21.4" />
      </g>
    </svg>
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
  return (await r.json()) as T;
}
