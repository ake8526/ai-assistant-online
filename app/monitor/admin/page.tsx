"use client";

import React, { useCallback, useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

// ---------------------------------------------------------------------------
// /monitor/admin — who may open the ops pages, and who may act on them.
// Viewing the log and stopping the day's jobs are separate rights on purpose.
// ---------------------------------------------------------------------------

type PermDef = { key: string; label: string; hint: string };
type RolesResp = {
  roles: Record<string, string[]>;
  roots: string[];
  perms: PermDef[];
  open: string[];
  openable: string[];
  you: string;
  error?: string;
};

const DEV = process.env.NODE_ENV !== "production";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@500;700&family=Press+Start+2P&family=VT323&display=swap');
.madm{--bg:#0a0a0a;--panel:#121212;--panel2:#171717;--ink:#f5f5f5;--dim:#7c7c7c;--red:#ee1b24;--green:#39d353;--amber:#f0b429;--hair:#262626;
  background:var(--bg);color:var(--ink);font-family:'VT323','IBM Plex Sans Thai',monospace;min-height:100vh;padding:10px 12px 40px}
.madm *{margin:0;padding:0;box-sizing:border-box}
.madm .pix{font-family:'Press Start 2P',monospace}
.madm header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:2px solid var(--hair);background:var(--panel);padding:8px 12px;margin-bottom:8px}
.madm header h1{font-size:12px}.madm header h1 em{color:var(--red);font-style:normal}
.madm .spacer{flex:1}
.madm a.link{font-size:14px;color:var(--dim);border:1px solid var(--hair);padding:3px 8px;text-decoration:none}
.madm a.link:hover{color:var(--ink);border-color:var(--ink)}
.madm .panel{border:2px solid var(--hair);background:var(--panel);margin-bottom:8px}
.madm .ph{font-size:8px;color:var(--dim);padding:6px 9px;border-bottom:2px solid var(--hair);background:var(--panel2)}
.madm table{width:100%;border-collapse:collapse;font-size:16px}
.madm th{text-align:left;color:var(--dim);font-weight:400;font-size:14px;padding:5px 9px;border-bottom:1px solid var(--hair)}
.madm td{padding:5px 9px;border-bottom:1px solid #1c1c1c;vertical-align:middle}
.madm tr:last-child td{border-bottom:none}
.madm td.u{color:#7dd3fc}
.madm .tagroot{color:var(--amber);border:1px solid #78350f;padding:0 6px;font-size:14px}
.madm label.p{display:inline-flex;gap:5px;align-items:center;margin-right:12px;cursor:pointer}
.madm input[type=checkbox]{accent-color:var(--red)}
.madm input[type=text]{background:var(--panel2);color:var(--ink);border:1px solid var(--hair);padding:4px 7px;font-family:inherit;font-size:16px;min-width:250px}
.madm input[type=text]:focus{outline:none;border-color:var(--red)}
.madm button{background:var(--panel2);color:var(--ink);border:1px solid var(--hair);padding:4px 10px;font-family:inherit;font-size:16px;cursor:pointer}
.madm button:hover{border-color:var(--ink)}
.madm button.go{border-color:var(--green);color:var(--green)}
.madm button.go:hover{background:var(--green);color:#06101f}
.madm button.rm{border-color:var(--red);color:var(--red)}
.madm button.rm:hover{background:var(--red);color:#fff}
.madm button:disabled{opacity:.5;cursor:default}
.madm .add{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:9px}
.madm .pick{position:relative;display:inline-block}
.madm .drop{position:absolute;top:100%;left:0;z-index:20;min-width:320px;border:1px solid var(--hair);background:var(--panel2);box-shadow:0 12px 30px -10px #000}
.madm .opt{display:flex;flex-direction:column;align-items:flex-start;gap:0;width:100%;text-align:left;border:none;border-bottom:1px solid #1c1c1c;padding:5px 9px}
.madm .opt:last-child{border-bottom:none}
.madm .opt:hover{background:#1f1f1f}
.madm .opt b{color:var(--ink);font-weight:400}
.madm .opt span{color:var(--dim);font-size:14px}
.madm .opt.dim{color:var(--dim);cursor:default}
.madm .inherit{color:var(--dim);font-size:13px;margin-right:5px}
.madm .who{color:var(--green);font-size:15px}
.madm .note{border:1px solid var(--amber);color:var(--amber);padding:8px 10px;margin-bottom:8px;font-size:16px}
.madm .note.bad{border-color:var(--red);color:var(--red)}
.madm .hint{color:var(--dim);font-size:15px;padding:0 9px 9px;line-height:1.5}
.madm .center{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center}
`;

function AdminView({ getToken }: { getToken: () => Promise<string | null> }) {
  const [data, setData] = useState<RolesResp | null>(null);
  const [msg, setMsg] = useState("");
  const [bad, setBad] = useState(false);
  const [denied, setDenied] = useState(false);
  const [newUpn, setNewUpn] = useState("");
  const [newPerms, setNewPerms] = useState<string[]>(["log.view"]);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ mail: string; name: string }[]>([]);
  const [picked, setPicked] = useState<{ mail: string; name: string } | null>(null);
  const [searching, setSearching] = useState(false);

  const headers = useCallback(async () => {
    const token = await getToken();
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [getToken]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/roles", { headers: await headers(), cache: "no-store" });
      if (r.status === 403 || r.status === 401) {
        setDenied(true);
        return;
      }
      const d = (await r.json()) as RolesResp;
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setDenied(false);
      setData(d);
    } catch (e) {
      setBad(true);
      setMsg(String(e).slice(0, 200));
    }
  }, [headers]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Look people up in the M365 directory by nickname — nobody should have to
  // recall an exact address to grant access. Same search the assistant uses.
  useEffect(() => {
    const q = newUpn.trim();
    const tooShort = picked?.mail === q.toLowerCase() || q.length < 2;
    let alive = true;
    const t = setTimeout(async () => {
      if (tooShort) {
        setFound([]);
        return;
      }
      setSearching(true);
      try {
        const r = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, {
          headers: await headers(),
          cache: "no-store",
        });
        if (!r.ok || !alive) return;
        const d = (await r.json()) as { users?: { mail: string; name: string }[] };
        if (alive) setFound(d.users || []);
      } catch {
        /* keep whatever is on screen */
      } finally {
        if (alive) setSearching(false);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [newUpn, picked, headers]);

  const saveOpen = useCallback(
    async (next: string[]) => {
      setBusy(true);
      setMsg("");
      setBad(false);
      try {
        const r = await fetch("/api/admin/roles", {
          method: "POST",
          headers: await headers(),
          body: JSON.stringify({ open: next }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setData((prev) => (prev ? { ...prev, open: d.open } : prev));
        setMsg("บันทึกสิทธิ์ที่เปิดให้ทุกคนแล้ว");
      } catch (e) {
        setBad(true);
        setMsg(String(e).replace(/^Error:\s*/, "").slice(0, 200));
      } finally {
        setBusy(false);
      }
    },
    [headers]
  );

  const save = useCallback(
    async (upn: string, perms: string[]) => {
      setBusy(true);
      setMsg("");
      setBad(false);
      try {
        const r = await fetch("/api/admin/roles", {
          method: "POST",
          headers: await headers(),
          body: JSON.stringify({ upn, perms }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setData((prev) => (prev ? { ...prev, roles: d.roles } : prev));
        setMsg(perms.length ? `บันทึกสิทธิ์ของ ${upn} แล้ว` : `ถอนสิทธิ์ของ ${upn} แล้ว`);
      } catch (e) {
        setBad(true);
        setMsg(String(e).replace(/^Error:\s*/, "").slice(0, 200));
      } finally {
        setBusy(false);
      }
    },
    [headers]
  );

  if (denied) {
    return (
      <div className="madm">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="pix" style={{ fontSize: 14, color: "#ee1b24" }}>
            ไม่มีสิทธิ์เข้าหน้านี้
          </div>
          <div style={{ fontSize: 19, color: "#7c7c7c", maxWidth: 520 }}>
            หน้าจัดการสิทธิ์เปิดให้เฉพาะผู้ดูแลระบบ — ติดต่อผู้ดูแลเพื่อขอสิทธิ์ «จัดการสิทธิ์»
          </div>
          <a className="link" href="/monitor">
            ← กลับห้องทำงาน
          </a>
        </div>
      </div>
    );
  }

  const perms = data?.perms || [];
  const entries = Object.entries(data?.roles || {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="madm">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header>
        <h1 className="pix">
          AI ASSISTANT · <em>จัดการสิทธิ์</em>
        </h1>
        <div className="spacer" />
        <a className="link" href="/monitor/usage" title="โทเค็นและค่าใช้จ่าย AI">
          ค่า AI →
        </a>
        <a className="link" href="/monitor/survey">
          ผลสำรวจ →
        </a>
        <a className="link" href="/monitor/log">
          ดู log →
        </a>
        <a className="link" href="/monitor">
          ← ห้องทำงาน
        </a>
      </header>

      {msg && <div className={`note${bad ? " bad" : ""}`}>{msg}</div>}

      <div className="panel">
        <div className="ph pix">เปิดให้ทุกคนที่ล็อกอิน M365</div>
        <div className="add">
          {(data?.openable || []).map((key) => {
            const def = (data?.perms || []).find((p) => p.key === key);
            const on = (data?.open || []).includes(key);
            return (
              <label className="p" key={key} title={def?.hint}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy}
                  onChange={(e) =>
                    void saveOpen(
                      e.target.checked
                        ? [...(data?.open || []), key]
                        : (data?.open || []).filter((x) => x !== key)
                    )
                  }
                />
                {def?.label || key}
              </label>
            );
          })}
        </div>
        <div className="hint">
          ติ๊กไว้ = พนักงานทุกคนที่ล็อกอิน M365 ได้ เข้าดูได้เลยโดยไม่ต้องเพิ่มรายชื่อ
          <br />
          «หยุดงานค้าง» และ «จัดการสิทธิ์» เปิดให้ทุกคนไม่ได้ — ต้องระบุรายคนเท่านั้น
        </div>
      </div>

      <div className="panel">
        <div className="ph pix">สิทธิ์เฉพาะราย</div>
        <table>
          <thead>
            <tr>
              <th>บัญชี</th>
              {perms.map((p) => (
                <th key={p.key} title={p.hint}>
                  {p.label}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.roots || []).map((upn) => (
              <tr key={`root-${upn}`}>
                <td className="u">
                  {upn} <span className="tagroot">ผู้ดูแลหลัก</span>
                </td>
                {perms.map((p) => (
                  <td key={p.key}>✔</td>
                ))}
                <td title="ตั้งจากตัวแปรระบบ ADMIN_UPNS — แก้ในหน้านี้ไม่ได้">แก้ที่ระบบ</td>
              </tr>
            ))}
            {entries.map(([upn, list]) => (
              <tr key={upn}>
                <td className="u">{upn}</td>
                {perms.map((p) => (
                  <td key={p.key} title={(data?.open || []).includes(p.key) ? "เปิดให้ทุกคนอยู่แล้ว" : undefined}>
                    {(data?.open || []).includes(p.key) && <span className="inherit">ทุกคน</span>}
                    <input
                      type="checkbox"
                      checked={list.includes(p.key)}
                      disabled={busy}
                      aria-label={`${p.label} ของ ${upn}`}
                      onChange={(e) =>
                        void save(
                          upn,
                          e.target.checked ? [...list, p.key] : list.filter((x) => x !== p.key)
                        )
                      }
                    />
                  </td>
                ))}
                <td>
                  <button className="rm" disabled={busy} onClick={() => void save(upn, [])}>
                    ลบออก
                  </button>
                </td>
              </tr>
            ))}
            {!entries.length && !(data?.roots || []).length && (
              <tr>
                <td colSpan={perms.length + 2} style={{ color: "#7c7c7c" }}>
                  ยังไม่มีใครได้รับสิทธิ์ — ตั้ง ADMIN_UPNS ในตัวแปรระบบก่อน
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="hint">
          {perms.map((p) => (
            <div key={p.key}>
              <b>{p.label}</b> — {p.hint}
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="ph pix">เพิ่มคน</div>
        <div className="add">
          <span className="pick">
            <input
              type="text"
              placeholder="พิมพ์ชื่อ/ชื่อเล่น เช่น เบส หรืออีเมลเต็ม"
              value={newUpn}
              onChange={(e) => {
                setNewUpn(e.target.value);
                setPicked(null);
              }}
            />
            {!!found.length && (
              <div className="drop">
                {found.map((u) => (
                  <button
                    key={u.mail}
                    className="opt"
                    onClick={() => {
                      setNewUpn(u.mail);
                      setPicked(u);
                      setFound([]);
                    }}
                  >
                    <b>{u.name}</b>
                    <span>{u.mail}</span>
                  </button>
                ))}
              </div>
            )}
            {searching && !found.length && <div className="drop"><div className="opt dim">กำลังค้นหาใน M365…</div></div>}
          </span>
          {picked && <span className="who">{picked.name}</span>}
          {perms.map((p) => (
            <label className="p" key={p.key} title={p.hint}>
              <input
                type="checkbox"
                checked={newPerms.includes(p.key)}
                onChange={(e) =>
                  setNewPerms((v) => (e.target.checked ? [...v, p.key] : v.filter((x) => x !== p.key)))
                }
              />
              {p.label}
            </label>
          ))}
          <button
            className="go"
            disabled={busy || !newUpn.includes("@") || !newPerms.length}
            onClick={() =>
              void save(newUpn.trim().toLowerCase(), newPerms).then(() => {
                setNewUpn("");
                setPicked(null);
              })
            }
          >
            เพิ่ม
          </button>
        </div>
      </div>
    </div>
  );
}

function Gate() {
  const { account, login, ready, getToken } = useM365Auth();
  if (!ready) {
    return (
      <div className="madm">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center pix" style={{ fontSize: 12 }}>
          กำลังโหลด…
        </div>
      </div>
    );
  }
  if (!account && !DEV) {
    return (
      <div className="madm">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="pix" style={{ fontSize: 14, color: "#ee1b24" }}>
            AI ASSISTANT · จัดการสิทธิ์
          </div>
          <div style={{ fontSize: 20, color: "#7c7c7c" }}>ต้องล็อกอิน Microsoft 365 ก่อน</div>
          <button onClick={() => login()} style={{ fontSize: 18, padding: "6px 14px" }}>
            เข้าสู่ระบบ M365
          </button>
        </div>
      </div>
    );
  }
  return <AdminView getToken={getToken} />;
}

export default function MonitorAdminPage() {
  return (
    <M365AuthProvider>
      <Gate />
    </M365AuthProvider>
  );
}
