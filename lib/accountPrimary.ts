/**
 * บัญชีหลัก + สิทธิ์สลับบัญชี (ฝั่งเบราว์เซอร์)
 *
 * บัญชีแรกที่เข้าสู่ระบบบนเครื่องนี้คือบัญชีหลัก
 * ปุ่ม "เลือกบัญชี" โชว์เมื่อมีสิทธิ์ account.switch หรือ admin
 * — ถ้าสลับไปบัญชีสองที่ไม่มีสิทธิ์ ยังอ้างสิทธิ์จากบัญชีหลักเพื่อสลับกลับได้
 */

const PRIMARY_KEY = "ktisx_primary_upn";
const SWITCH_KEY = "ktisx_account_switch";

const norm = (upn: string) => (upn || "").trim().toLowerCase();

function maySwitch(perms: string[] | undefined | null): boolean {
  return !!perms?.includes("account.switch") || !!perms?.includes("admin");
}

export function getPrimaryUpn(): string {
  if (typeof window === "undefined") return "";
  try {
    return norm(localStorage.getItem(PRIMARY_KEY) || "");
  } catch {
    return "";
  }
}

/** บันทึกบัญชีแรกเป็นหลัก; ถ้ามีสิทธิ์เปลี่ยนบัญชี เปิดสิทธิ์สลับบนเครื่องนี้ */
export function rememberPrimaryAccount(upn: string, canSwitch: boolean): void {
  if (typeof window === "undefined") return;
  const u = norm(upn);
  if (!u || !u.includes("@")) return;
  try {
    if (!localStorage.getItem(PRIMARY_KEY)) {
      localStorage.setItem(PRIMARY_KEY, u);
    }
    if (canSwitch) {
      localStorage.setItem(SWITCH_KEY, "1");
      const primary = norm(localStorage.getItem(PRIMARY_KEY) || "");
      if (!primary) localStorage.setItem(PRIMARY_KEY, u);
    }
  } catch {
    /* โหมดส่วนตัว */
  }
}

/** ออกจากระบบจริง — ล้างทั้งบัญชีหลักและสิทธิ์สลับบนเครื่องนี้ */
export function clearPrimaryAccount(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PRIMARY_KEY);
    localStorage.removeItem(SWITCH_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * โชว์ปุ่มเลือกบัญชีเมื่อ:
 * - บัญชีปัจจุบันมีสิทธิ์ account.switch / admin หรือ
 * - เคยบันทึกว่าบัญชีหลักมีสิทธิ์ (สลับไปบัญชีอื่นแล้วยังกลับได้)
 */
export function canSwitchAccounts(currentPerms: string[] | undefined | null): boolean {
  if (maySwitch(currentPerms)) return true;
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(SWITCH_KEY) === "1";
  } catch {
    return false;
  }
}

export { maySwitch as hasSwitchPerm };
