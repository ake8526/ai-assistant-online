// Who may see the operations pages, and who may act on them.
//
// Until now /monitor/log was open to any signed-in M365 user — every colleague
// could read when each person was served and could press the button that stops
// the day's deliveries for everyone. Viewing and acting are separate rights
// here, because "let me look at this morning" and "stop the morning" are very
// different asks.
//
// Storage is one row in `settings` (_ops/roles), so this needs no migration —
// the table already exists and is reachable only through the service key.
// Root admins come from the ADMIN_UPNS env var and can never be locked out by
// an edit made in the UI.
import { getSetting, setSetting } from "@/lib/store";

const OWNER = "_ops";
const KEY = "roles";

export type Perm = "monitor.view" | "log.view" | "jobs.stop" | "admin";

export const PERMS: { key: Perm; label: string; hint: string }[] = [
  { key: "monitor.view", label: "ดูห้องทำงาน", hint: "เปิดหน้า /monitor และดูงานที่กำลังทำสด ๆ" },
  { key: "log.view", label: "ดู log", hint: "เปิดหน้า /monitor/log และดูประวัติการทำงาน" },
  { key: "jobs.stop", label: "หยุดงานค้าง", hint: "กดปุ่มหยุด/พักงานที่ระบบตั้งเวลาไว้" },
  { key: "admin", label: "จัดการสิทธิ์", hint: "เพิ่ม/ลบสิทธิ์ของคนอื่น" },
];

export type RoleMap = Record<string, Perm[]>;

const norm = (upn: string) => (upn || "").trim().toLowerCase();

/** The account this deployment belongs to. Kept in code so a missing or
 *  mistyped env var can never lock the owner out of their own system. */
const OWNER_UPN = "weerasak.pi@ktisgroup.com";

/**
 * Accounts that always hold every permission and cannot be edited from the UI.
 * ADMIN_UPNS (comma-separated) adds more; the owner is always among them.
 */
export function rootAdmins(): string[] {
  const fromEnv = (process.env.ADMIN_UPNS || "")
    .split(",")
    .map(norm)
    .filter(Boolean);
  return [...new Set([OWNER_UPN, ...fromEnv])];
}

export function isRootAdmin(upn: string): boolean {
  return rootAdmins().includes(norm(upn));
}

/**
 * Permissions everyone who can sign in already holds. The agent room shows no
 * history and no controls, so it is open to the whole company by default;
 * acting on jobs and managing people never can be.
 */
const OPEN_KEY = "open_perms";
const OPENABLE: Perm[] = ["monitor.view", "log.view"];
const OPEN_DEFAULT: Perm[] = ["monitor.view"];

export async function openPerms(): Promise<Perm[]> {
  const raw = await getSetting(OWNER, OPEN_KEY);
  if (raw === null) return OPEN_DEFAULT; // never configured → the default stands
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return OPEN_DEFAULT;
    return parsed.filter((p): p is Perm => OPENABLE.includes(p as Perm));
  } catch {
    return OPEN_DEFAULT;
  }
}

export async function setOpenPerms(perms: string[]): Promise<Perm[]> {
  const kept = perms.filter((p): p is Perm => OPENABLE.includes(p as Perm));
  await setSetting(OWNER, OPEN_KEY, JSON.stringify(kept));
  return kept;
}

export function openablePerms(): Perm[] {
  return [...OPENABLE];
}

export async function loadRoles(): Promise<RoleMap> {
  const raw = await getSetting(OWNER, KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as RoleMap;
    const out: RoleMap = {};
    for (const [upn, perms] of Object.entries(parsed || {})) {
      if (!Array.isArray(perms)) continue;
      const kept = perms.filter((p): p is Perm => PERMS.some((x) => x.key === p));
      if (kept.length) out[norm(upn)] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveRoles(map: RoleMap): Promise<void> {
  const clean: RoleMap = {};
  for (const [upn, perms] of Object.entries(map)) {
    const u = norm(upn);
    if (!u || !u.includes("@")) continue;
    const kept = [...new Set(perms)].filter((p): p is Perm => PERMS.some((x) => x.key === p));
    if (kept.length) clean[u] = kept;
  }
  await setSetting(OWNER, KEY, JSON.stringify(clean));
}

/** Every permission this account holds — its own, plus whatever is open to all. */
export async function permsOf(upn: string): Promise<Perm[]> {
  if (isRootAdmin(upn)) return PERMS.map((p) => p.key);
  const [map, open] = await Promise.all([loadRoles(), openPerms()]);
  return [...new Set([...(map[norm(upn)] || []), ...open])];
}

export async function can(upn: string, perm: Perm): Promise<boolean> {
  return (await permsOf(upn)).includes(perm);
}
