"use client";

import React, { useCallback, useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

// ---------------------------------------------------------------------------
// /monitor/log — log ย้อนหลัง. /monitor is a live tail that starts at the tip;
// this page reads the same agent_traces rows by Bangkok day so a past morning
// can be audited (ใครถูกส่ง เวลาไหน ค้างตรงขั้นไหน). Stages only — no message
// text is ever stored, so nothing here can leak a conversation.
// ---------------------------------------------------------------------------

type LogEvent = { clock: string; step: string; label: string; status: string; ms: number };
type LogJob = {
  traceId: string;
  user: string;
  channel: string;
  clock: string;
  durationMs: number;
  title: string;
  outcome: "ok" | "quiet" | "error" | "incomplete";
  events: LogEvent[];
};
type Activity = {
  title: string;
  runs: number;
  users: number;
  lastClock: string;
  lastAgoSec: number;
  ok: number;
  quiet: number;
  errors: number;
  incomplete: number;
  channel: string;
};
type LogResp = {
  date: string;
  today?: boolean;
  truncated?: boolean;
  note?: string;
  activityWindowMin?: number;
  activity?: Activity[];
  summary: {
    traces: number;
    events: number;
    ok?: number;
    quiet?: number;
    errors?: number;
    incomplete?: number;
    users: string[];
    channels: string[];
  };
  traces: LogJob[];
};

const DEV = process.env.NODE_ENV !== "production";
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

const STEP_TH: Record<string, string> = {
  receive: "รับเรื่อง",
  parse: "แยกเจตนา",
  fetch: "ดึงข้อมูล",
  compose: "เขียนคำตอบ",
  reply: "ส่งออก",
  error: "ล้มเหลว",
};

const OUTCOME_TH: Record<LogJob["outcome"], string> = {
  ok: "สำเร็จ",
  quiet: "ไม่มีอะไรต้องส่ง",
  error: "ผิดพลาด",
  incomplete: "ไม่จบงาน",
};

function ago(sec: number): string {
  if (sec < 60) return `${sec} วินาทีที่แล้ว`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} นาทีที่แล้ว`;
  return `${Math.floor(m / 60)} ชม.${m % 60} นาทีที่แล้ว`;
}

function bkkToday(): string {
  return new Date(Date.now() + BKK_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@500;700&family=Press+Start+2P&family=VT323&display=swap');
.mlog{--bg:#0a0a0a;--panel:#121212;--panel2:#171717;--ink:#f5f5f5;--dim:#7c7c7c;--red:#ee1b24;--green:#39d353;--amber:#f0b429;--hair:#262626;
  background:var(--bg);color:var(--ink);font-family:'VT323','IBM Plex Sans Thai',monospace;min-height:100vh;padding:10px 12px 40px}
.mlog *{margin:0;padding:0;box-sizing:border-box}
.mlog .pix{font-family:'Press Start 2P',monospace}
.mlog header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:2px solid var(--hair);background:var(--panel);padding:8px 12px;margin-bottom:8px}
.mlog header h1{font-size:12px}.mlog header h1 em{color:var(--red);font-style:normal}
.mlog .spacer{flex:1}
.mlog a.link{font-size:14px;color:var(--dim);border:1px solid var(--hair);padding:3px 8px;text-decoration:none}
.mlog a.link:hover{color:var(--ink);border-color:var(--ink)}
.mlog .bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;border:2px solid var(--hair);background:var(--panel);padding:8px 10px;margin-bottom:8px}
.mlog input,.mlog select{background:var(--panel2);color:var(--ink);border:1px solid var(--hair);padding:4px 7px;font-family:inherit;font-size:16px}
.mlog input:focus,.mlog select:focus{outline:none;border-color:var(--red)}
.mlog button{background:var(--panel2);color:var(--ink);border:1px solid var(--hair);padding:4px 10px;font-family:inherit;font-size:16px;cursor:pointer}
.mlog button:hover{border-color:var(--ink)}
.mlog button.on{border-color:var(--red);color:#fff}
.mlog button.danger{border-color:var(--red);color:var(--red)}
.mlog button.danger:hover{background:var(--red);color:#fff}
.mlog button:disabled{opacity:.5;cursor:default}
.mlog .bar .spacer{flex:1}
.mlog .stats{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.mlog .stat{border:1px solid var(--hair);background:var(--panel);padding:4px 9px;font-size:15px;color:var(--dim)}
.mlog .stat b{font-size:18px}
.mlog .stat.ok b{color:var(--green)}.mlog .stat.err b{color:var(--red)}.mlog .stat.inc b{color:var(--amber)}
.mlog .stat.quiet b{color:#60a5fa}
/* "งานที่วนอยู่" — recurring cron work folded by job name */
.mlog .act{border:2px solid var(--hair);background:var(--panel);margin-bottom:8px}
.mlog .act .ah{font-size:8px;color:var(--dim);padding:6px 9px;border-bottom:2px solid var(--hair);background:var(--panel2)}
.mlog .act table{width:100%;border-collapse:collapse;font-size:16px}
.mlog .act th{text-align:left;color:var(--dim);font-weight:400;font-size:14px;padding:4px 9px;border-bottom:1px solid var(--hair)}
.mlog .act td{padding:4px 9px;border-bottom:1px solid #1c1c1c}
.mlog .act tr:last-child td{border-bottom:none}
.mlog .act td.n{color:var(--ink)}
.mlog .act .dim{color:var(--dim);font-size:14px}
.mlog .tag{display:inline-block;border:1px solid var(--hair);padding:0 6px;margin-right:4px;font-size:14px}
.mlog .tag.ok{color:var(--green);border-color:#14532d}
.mlog .tag.quiet{color:#60a5fa;border-color:#1e3a8a}
.mlog .tag.err{color:var(--red);border-color:#7f1d1d}
.mlog .tag.inc{color:var(--amber);border-color:#78350f}
.mlog .job{border:1px solid var(--hair);background:var(--panel);margin-bottom:4px}
.mlog .jh{display:flex;gap:10px;align-items:center;padding:5px 9px;cursor:pointer;font-size:16px}
.mlog .jh:hover{background:var(--panel2)}
.mlog .jh .t{color:var(--amber);min-width:70px}
.mlog .jh .u{color:#7dd3fc;min-width:110px}
.mlog .jh .c{color:var(--dim);min-width:52px;font-size:14px}
.mlog .jh .ttl{flex:1;color:var(--ink)}
.mlog .jh .d{color:var(--dim);font-size:14px}
.mlog .dot{width:9px;height:9px;flex:none}
.mlog .dot.ok{background:var(--green)}.mlog .dot.error{background:var(--red)}.mlog .dot.incomplete{background:var(--amber)}
.mlog .dot.quiet{background:#60a5fa}
.mlog .steps{border-top:1px solid var(--hair);background:#0d0d0d;padding:5px 9px 7px}
.mlog .ev{display:flex;gap:10px;font-size:15px;color:var(--dim);line-height:1.5}
.mlog .ev .st{color:#a3a3a3;min-width:80px}
.mlog .ev .lb{color:var(--ink)}
.mlog .ev.error .lb,.mlog .ev.error .st{color:var(--red)}
.mlog .empty{border:1px dashed var(--hair);padding:20px;text-align:center;color:var(--dim);font-size:18px}
.mlog .note{border:1px solid var(--amber);color:var(--amber);padding:8px 10px;margin-bottom:8px;font-size:16px}
.mlog .center{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
/* Own confirm dialog — window.confirm() cannot be themed and reads as the browser talking */
.mlog .modal-back{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:80;padding:16px}
.mlog .modal{border:2px solid var(--red);background:var(--panel);max-width:520px;width:100%;box-shadow:0 0 0 4px #000}
.mlog .modal .mt{font-size:9px;color:var(--red);padding:9px 12px;border-bottom:2px solid var(--hair);background:var(--panel2)}
.mlog .modal .mb{padding:12px;font-size:17px;line-height:1.55}
.mlog .modal .mb b{color:var(--amber)}
.mlog .modal .mb ul{margin:8px 0 0 18px;color:var(--dim)}
.mlog .modal .mb li{margin-bottom:2px}
.mlog .modal .ma{display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:2px solid var(--hair);background:var(--panel2)}
`;

function JobRow({ job }: { job: LogJob }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="job">
      <div className="jh" onClick={() => setOpen((v) => !v)}>
        <span className={`dot ${job.outcome}`} title={OUTCOME_TH[job.outcome]} />
        <span className="t">{job.clock}</span>
        <span className="u">{job.user}</span>
        <span className="c">{job.channel}</span>
        <span className="ttl">{job.title}</span>
        <span className="d">
          {job.events.length} ขั้น · {(job.durationMs / 1000).toFixed(1)}s {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="steps">
          {job.events.map((e, i) => (
            <div key={i} className={`ev${e.status === "error" || e.step === "error" ? " error" : ""}`}>
              <span>{e.clock}</span>
              <span className="st">{STEP_TH[e.step] || e.step}</span>
              <span className="lb">{e.label || "—"}</span>
              <span>+{(e.ms / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LogView({ getToken }: { getToken: () => Promise<string | null> }) {
  const [date, setDate] = useState(bkkToday());
  const [user, setUser] = useState("");
  const [channel, setChannel] = useState("");
  const [q, setQ] = useState("");
  const [problems, setProblems] = useState(false);
  const [data, setData] = useState<LogResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelMsg, setCancelMsg] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const p = new URLSearchParams({ date });
      if (user) p.set("user", user);
      if (channel) p.set("channel", channel);
      if (q) p.set("q", q);
      if (problems) p.set("problems", "1");
      const r = await fetch(`/api/monitor/log?${p}`, { headers, cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d as LogResp);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }, [getToken, date, user, channel, q, problems]);

  // Debounced: the user/keyword boxes change on every keystroke, and a query per
  // keystroke would hammer a table that holds every stage of every request.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  // Esc closes the dialog — expected of anything that replaces window.confirm().
  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen]);

  // Stop the scheduler retrying today's morning deliveries. The confirm step is
  // our own dialog, not window.confirm() — the browser's box is chrome-styled,
  // shows the bare hostname, and cannot say this skips today for everyone.
  const cancelPending = useCallback(async () => {
    setConfirmOpen(false);
    setCancelling(true);
    setCancelMsg("");
    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch("/api/monitor/cancel?scope=all&kind=both", { method: "POST", headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setCancelMsg(`หยุดงานค้างแล้ว ${d.count} รายการ จากผู้ใช้ ${d.users} คน`);
      void load();
    } catch (e) {
      setCancelMsg(`หยุดไม่สำเร็จ: ${String(e).slice(0, 200)}`);
    } finally {
      setCancelling(false);
    }
  }, [getToken, load]);

  const s = data?.summary;

  return (
    <div className="mlog">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <header>
        <h1 className="pix">
          AI ASSISTANT · <em>LOG ย้อนหลัง</em>
        </h1>
        <div className="spacer" />
        <a className="link" href="/monitor">
          ← กลับห้องทำงาน (สด)
        </a>
      </header>

      <div className="bar">
        <button onClick={() => setDate(shiftDate(date, -1))}>◀ วันก่อน</button>
        <input type="date" value={date} max={bkkToday()} onChange={(e) => setDate(e.target.value || bkkToday())} />
        <button onClick={() => setDate(shiftDate(date, 1))} disabled={date >= bkkToday()}>
          วันถัดไป ▶
        </button>
        <button onClick={() => setDate(bkkToday())}>วันนี้</button>
        <input placeholder="ผู้ใช้ (เช่น weerasak)" value={user} onChange={(e) => setUser(e.target.value)} />
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">ทุกช่องทาง</option>
          <option value="line">LINE</option>
          <option value="web">Web</option>
          <option value="cron">Cron</option>
        </select>
        <input placeholder="ค้นในคำอธิบาย เช่น สรุปตารางเช้า" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={problems ? "on" : ""} onClick={() => setProblems((v) => !v)}>
          เฉพาะที่มีปัญหา
        </button>
        <button onClick={() => void load()}>{loading ? "กำลังโหลด…" : "รีเฟรช"}</button>
        <div className="spacer" />
        <button className="danger" onClick={() => setConfirmOpen(true)} disabled={cancelling}>
          {cancelling ? "กำลังหยุด…" : "■ หยุดงานค้าง"}
        </button>
      </div>

      {confirmOpen && (
        <div className="modal-back" onClick={() => setConfirmOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mt pix" id="confirm-title">
              ■ หยุดงานค้าง
            </div>
            <div className="mb">
              <p>
                หยุดงานค้าง<b> ของวันนี้ </b>ทั้งหมด — สรุปตารางเช้า + ข่าวเช้า ของผู้ใช้ทุกคน
              </p>
              <ul>
                <li>ระบบจะเลิกพยายามส่งซ้ำ จนถึงรอบพรุ่งนี้</li>
                <li>ไม่มีการลบข้อมูล ตั้งค่าเวลาส่งเดิมยังอยู่ครบ</li>
                <li>พิมพ์สั่งเองใน LINE เช่น «สรุปตารางเช้า» ยังใช้ได้ตามปกติ</li>
              </ul>
            </div>
            <div className="ma">
              <button onClick={() => setConfirmOpen(false)}>ยกเลิก</button>
              <button className="danger" onClick={() => void cancelPending()} autoFocus>
                ยืนยัน หยุดงานค้าง
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelMsg && <div className="note">{cancelMsg}</div>}

      {err && <div className="note">โหลดไม่สำเร็จ: {err}</div>}
      {data?.note && <div className="note">{data.note}</div>}
      {data?.truncated && <div className="note">วันนี้มี event เยอะมาก — แสดงเท่าที่ดึงได้ ลองกรองผู้ใช้/คำค้นเพิ่ม</div>}

      {s && (
        <div className="stats">
          <div className="stat">
            งานทั้งหมด <b>{s.traces}</b>
          </div>
          <div className="stat ok">
            สำเร็จ <b>{s.ok ?? 0}</b>
          </div>
          <div className="stat quiet" title="งานที่ทำงานปกติ แต่รอบนั้นไม่มีอะไรต้องส่ง">
            ไม่มีอะไรต้องส่ง <b>{s.quiet ?? 0}</b>
          </div>
          <div className="stat err">
            ผิดพลาด <b>{s.errors ?? 0}</b>
          </div>
          <div className="stat inc" title="เริ่มแล้วแต่ไม่มีขั้นสุดท้าย และไม่ได้บันทึกว่าล้มเหลว">
            ไม่จบงาน <b>{s.incomplete ?? 0}</b>
          </div>
          <div className="stat">
            ขั้นตอนรวม <b>{s.events}</b>
          </div>
          <div className="stat">ผู้ใช้: {s.users.join(", ") || "—"}</div>
        </div>
      )}

      {data?.today && !!data.activity?.length && (
        <div className="act">
          <div className="ah pix">
            งานที่วนอยู่ · {data.activityWindowMin ?? 30} นาทีล่าสุด
          </div>
          <table>
            <thead>
              <tr>
                <th>งาน</th>
                <th>รอบ</th>
                <th>คน</th>
                <th>ล่าสุด</th>
                <th>ผลลัพธ์</th>
              </tr>
            </thead>
            <tbody>
              {data.activity.map((a) => (
                <tr key={a.title}>
                  <td className="n">{a.title}</td>
                  <td>{a.runs}</td>
                  <td>{a.users || "—"}</td>
                  <td>
                    {a.lastClock} <span className="dim">({ago(a.lastAgoSec)})</span>
                  </td>
                  <td>
                    {a.ok > 0 && <span className="tag ok">สำเร็จ {a.ok}</span>}
                    {a.quiet > 0 && <span className="tag quiet">ไม่มีอะไรต้องส่ง {a.quiet}</span>}
                    {a.errors > 0 && <span className="tag err">ผิดพลาด {a.errors}</span>}
                    {a.incomplete > 0 && <span className="tag inc">ไม่จบงาน {a.incomplete}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && data && data.traces.length === 0 && (
        <div className="empty">ไม่มี log ตามเงื่อนไขนี้ในวันที่ {data.date}</div>
      )}

      {data?.traces.map((j) => (
        <JobRow key={j.traceId} job={j} />
      ))}
    </div>
  );
}

function Gate() {
  const { account, login, ready, getToken } = useM365Auth();
  if (!ready) {
    return (
      <div className="mlog">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center pix" style={{ fontSize: 12 }}>
          กำลังโหลด…
        </div>
      </div>
    );
  }
  if (!account && !DEV) {
    return (
      <div className="mlog">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="pix" style={{ fontSize: 14, color: "#ee1b24" }}>
            AI ASSISTANT · LOG
          </div>
          <div style={{ fontSize: 20, color: "#7c7c7c" }}>ต้องล็อกอิน Microsoft 365 เพื่อดูหน้านี้</div>
          <button onClick={() => login()} style={{ fontSize: 18, padding: "6px 14px" }}>
            เข้าสู่ระบบ M365
          </button>
        </div>
      </div>
    );
  }
  return <LogView getToken={getToken} />;
}

export default function MonitorLogPage() {
  return (
    <M365AuthProvider>
      <Gate />
    </M365AuthProvider>
  );
}
