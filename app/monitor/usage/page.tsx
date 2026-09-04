"use client";

import React, { useCallback, useEffect, useState } from "react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

// ---------------------------------------------------------------------------
// /monitor/usage — ใช้ AI ไปกี่โทเค็น คิดเป็นเงินเท่าไหร่ และหมดไปกับงานอะไร
//
// เหตุที่ต้องมี: หน้า usage ของ Google บอกได้แค่ยอดรวมของคีย์ และช้าราวหนึ่งวัน
// ตอบไม่ได้ว่ายอดที่พุ่งขึ้นมาเป็นค่าสรุปข่าว ค่าสรุปประชุม หรือค่าอ่านรูป
// หน้านี้จึงนับจากฝั่งเราเอง แยกตามงานและตามรุ่น เห็นทันทีในนาทีที่ใช้
//
// ตัวเลขที่นี่เป็น "ประมาณการ" เสมอ — ยอดที่ถูกเรียกเก็บจริงอยู่ที่ billing ของ
// ผู้ให้บริการ หน้านี้เขียนบอกไว้ตรง ๆ ไม่ปล่อยให้เข้าใจว่าเป็นใบเสร็จ
// ---------------------------------------------------------------------------

type Bucket = { n: number; in: number; out: number; usd: number };
type DayRow = Bucket & { d: string; unpriced: number };
type Report = {
  from: string;
  to: string;
  thbPerUsd: number;
  days: DayRow[];
  byModel: (Bucket & { id: string })[];
  byTask: (Bucket & { id: string })[];
  total: Bucket & { unpriced: number };
  today: Bucket;
  unknownModels: string[];
  prices: { id: string; in: number; out: number }[];
};

const TASK_TH: Record<string, string> = {
  news: "สรุปข่าว",
  meeting: "สรุปประชุม",
  ocr: "อ่านรูป",
  voice: "ถอดเสียง",
  intent: "แยกเจตนา",
  parse: "อ่านข้อมูล",
  chat: "ตอบแชท",
};

const TASK_HINT: Record<string, string> = {
  news: "สรุปข่าวเช้าและข่าวรอบวัน",
  meeting: "ถอดสรุปประชุมเป็นประเด็นและงาน",
  ocr: "อ่านรูปที่ส่งเข้ามาทาง LINE",
  voice: "ถอดข้อความจากเสียง",
  intent: "อ่านว่าข้อความที่พิมพ์มาต้องการอะไร — เกิดทุกข้อความ",
  parse: "อ่านข้อมูลดิบให้เป็นโครงสร้าง",
  chat: "เขียนคำตอบให้ผู้ใช้",
};

const CSS = `
body{background:#0e0e0f}
.mu{min-height:100vh;background:#0e0e0f;color:#ececec;font-family:'IBM Plex Sans Thai','Segoe UI',system-ui,sans-serif;padding:22px 18px 70px}
.mu .wrap{max-width:1040px;margin:0 auto}
.mu .kick{color:#ee1b24;font-size:12px;letter-spacing:.16em;text-transform:uppercase}
.mu h1{font-size:23px;font-weight:700;margin:4px 0 2px}
.mu .sub{color:#8a8a8a;font-size:14px;margin-bottom:18px}
.mu .card{background:#171718;border:1px solid #2a2a2c;border-radius:12px;padding:14px 16px;margin-bottom:14px}
.mu h2{font-size:13px;color:#9a9a9a;font-weight:600;letter-spacing:.06em;margin-bottom:10px}
.mu .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:14px}
.mu .tile{background:#171718;border:1px solid #2a2a2c;border-radius:12px;padding:14px 16px}
.mu .tile .lab{color:#8a8a8a;font-size:12.5px}
.mu .tile .big{font-size:27px;font-weight:700;font-variant-numeric:tabular-nums;margin:3px 0 1px}
.mu .tile .fine{color:#7c7c7c;font-size:12.5px;font-variant-numeric:tabular-nums}
.mu .range{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.mu button{font:inherit;font-size:13px;background:#232325;color:#ececec;border:1px solid #3a3a3c;border-radius:8px;padding:4px 12px;cursor:pointer}
.mu button:hover:not(:disabled){background:#2c2c2f}
.mu button.on{border-color:#ee1b24;color:#fff}
.mu button:disabled{opacity:.45;cursor:not-allowed}
.mu .scroll{overflow-x:auto}
.mu table{width:100%;border-collapse:collapse;font-size:14px;min-width:560px}
.mu th{text-align:left;color:#7c7c7c;font-weight:600;font-size:12px;padding:6px 8px;border-bottom:1px solid #2a2a2c;white-space:nowrap}
.mu td{padding:7px 8px;border-bottom:1px solid #202022;vertical-align:middle}
.mu tr:last-child td{border-bottom:none}
.mu .num{text-align:right;font-variant-numeric:tabular-nums;color:#c9c9c9;white-space:nowrap}
.mu .thb{text-align:right;font-variant-numeric:tabular-nums;color:#ececec;font-weight:600;white-space:nowrap}
.mu .hint{color:#6f6f6f;font-size:12.5px}
.mu .bars{display:flex;flex-direction:column;gap:3px}
.mu .row{display:grid;grid-template-columns:74px 1fr 92px;gap:9px;align-items:center;font-size:13px}
.mu .row .day{color:#8a8a8a;font-variant-numeric:tabular-nums}
.mu .row .track{background:#202022;border-radius:4px;height:15px;overflow:hidden}
.mu .row .fill{background:linear-gradient(90deg,#ee1b24,#f0673f);height:100%;border-radius:4px;min-width:2px}
.mu .row .val{text-align:right;font-variant-numeric:tabular-nums;color:#c9c9c9}
.mu .note{color:#8a8a8a;font-size:13.5px;line-height:1.75}
.mu .note b{color:#ececec;font-weight:600}
.mu .warn{border-color:#78350f}
.mu .warn h2{color:#fbbf24}
.mu .link{color:#7dd3fc;text-decoration:none}
.mu .center{min-height:70vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center}
.mu .empty{color:#7c7c7c;font-size:14px;padding:8px 2px}
`;

const nf = new Intl.NumberFormat("th-TH");
const baht = (usd: number, rate: number) => {
  const b = usd * rate;
  if (b === 0) return "0.00";
  if (b < 0.01) return "<0.01";
  return b.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const dayLabel = (d: string) => {
  const [, m, day] = d.split("-");
  return `${day}/${m}`;
};

function Tile({ lab, big, fine }: { lab: string; big: string; fine: string }) {
  return (
    <div className="tile">
      <div className="lab">{lab}</div>
      <div className="big">{big}</div>
      <div className="fine">{fine}</div>
    </div>
  );
}

function UsageView({ getToken }: { getToken: () => Promise<string | null> }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (span: number) => {
      setBusy(true);
      try {
        const token = await getToken();
        const r = await fetch(`/api/monitor/usage?days=${span}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store",
        });
        // 403 ไม่ใช่ปัญหาการล็อกอิน ล็อกอินใหม่ก็ไม่ได้สิทธิ์เพิ่ม
        if (r.status === 403) {
          setDenied(true);
          return;
        }
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        setData(j as Report);
        setErr("");
      } catch (e) {
        setErr(String(e).slice(0, 200));
      } finally {
        setBusy(false);
      }
    },
    [getToken]
  );

  useEffect(() => {
    // ยิงนอก effect body ตามแบบเดียวกับหน้าอื่นในห้องนี้ — setState ตรง ๆ ใน effect
    // ทำให้ React เรนเดอร์ซ้อนกัน และ eslint ของ Next รุ่นนี้ปัดตกด้วย
    const t = setTimeout(() => void load(days), 0);
    return () => clearTimeout(t);
  }, [load, days]);

  if (denied) {
    return (
      <div className="mu">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="kick">ไม่มีสิทธิ์</div>
          <div style={{ color: "#8a8a8a", maxWidth: 460, fontSize: 15 }}>
            หน้านี้เป็นตัวเลขค่าใช้จ่าย เปิดให้เฉพาะผู้ที่ได้รับสิทธิ์ «จัดการสิทธิ์»
          </div>
          <a className="link" href="/monitor">
            ← กลับห้องทำงาน
          </a>
        </div>
      </div>
    );
  }

  const rate = data?.thbPerUsd ?? 35;
  const total = data?.total;
  const today = data?.today;
  const rows = data?.days || [];
  const nDays = Math.max(1, rows.length);
  const avgUsd = total ? total.usd / nDays : 0;
  const maxUsd = Math.max(0.0000001, ...rows.map((r) => r.usd));

  return (
    <div className="mu">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <div className="kick">AI ASSISTANT · ค่า AI</div>
        <h1>ใช้ AI ไปเท่าไหร่แล้ว</h1>
        <div className="sub">
          {data ? `${data.from} ถึง ${data.to}` : "กำลังโหลด…"} ·{" "}
          <a className="link" href="/monitor">
            ห้องทำงาน
          </a>{" "}
          ·{" "}
          <a className="link" href="/monitor/log">
            log
          </a>
        </div>

        <div className="range">
          {[7, 30, 90].map((d) => (
            <button key={d} className={d === days ? "on" : ""} disabled={busy} onClick={() => setDays(d)}>
              {d} วัน
            </button>
          ))}
          <button disabled={busy} onClick={() => void load(days)}>
            รีเฟรช
          </button>
        </div>

        <div className="tiles">
          <Tile
            lab="วันนี้"
            big={`฿${today ? baht(today.usd, rate) : "—"}`}
            fine={today ? `${nf.format(today.in + today.out)} โทเค็น · ${nf.format(today.n)} ครั้ง` : "—"}
          />
          <Tile
            lab={rows.length ? `รวม ${rows.length} วันที่มีการใช้` : "รวมช่วงที่เลือก"}
            big={`฿${total ? baht(total.usd, rate) : "—"}`}
            fine={total ? `${nf.format(total.in + total.out)} โทเค็น · ${nf.format(total.n)} ครั้ง` : "—"}
          />
          <Tile
            lab="เฉลี่ยต่อวัน"
            big={`฿${baht(avgUsd, rate)}`}
            fine={`ถ้าใช้เท่านี้ทุกวัน ≈ ฿${baht(avgUsd * 30, rate)}/เดือน`}
          />
        </div>

        <div className="card">
          <h2>หมดไปกับงานอะไร</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>งาน</th>
                  <th className="num">ครั้ง</th>
                  <th className="num">โทเค็นเข้า</th>
                  <th className="num">โทเค็นออก</th>
                  <th className="num">บาท</th>
                  <th className="num">ต่อครั้ง</th>
                </tr>
              </thead>
              <tbody>
                {(data?.byTask || []).map((t) => (
                  <tr key={t.id}>
                    <td>
                      {TASK_TH[t.id] || t.id}
                      <div className="hint">{TASK_HINT[t.id] || ""}</div>
                    </td>
                    <td className="num">{nf.format(t.n)}</td>
                    <td className="num">{nf.format(t.in)}</td>
                    <td className="num">{nf.format(t.out)}</td>
                    <td className="thb">{baht(t.usd, rate)}</td>
                    <td className="num">{baht(t.n ? t.usd / t.n : 0, rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data?.byTask.length && <div className="empty">ยังไม่มีการใช้งานในช่วงนี้</div>}
        </div>

        <div className="card">
          <h2>แยกตามรุ่นที่เรียกใช้</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>รุ่น</th>
                  <th className="num">ครั้ง</th>
                  <th className="num">โทเค็นเข้า</th>
                  <th className="num">โทเค็นออก</th>
                  <th className="num">บาท</th>
                </tr>
              </thead>
              <tbody>
                {(data?.byModel || []).map((m) => (
                  <tr key={m.id}>
                    <td>{m.id}</td>
                    <td className="num">{nf.format(m.n)}</td>
                    <td className="num">{nf.format(m.in)}</td>
                    <td className="num">{nf.format(m.out)}</td>
                    <td className="thb">{baht(m.usd, rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data?.byModel.length && <div className="empty">ยังไม่มีการใช้งานในช่วงนี้</div>}
        </div>

        {!!data?.unknownModels.length && (
          <div className="card warn">
            <h2>มีรุ่นที่ยังไม่รู้ราคา</h2>
            <div className="note">
              {data.unknownModels.join(", ")} — นับโทเค็นให้แล้วแต่ยังไม่คิดเป็นเงิน ยอดบาทด้านบนจึง
              <b> ต่ำกว่าจริง</b> เติมราคาได้ที่ตาราง <code>PRICE</code> ใน <code>lib/llmUsage.ts</code>
            </div>
          </div>
        )}

        <div className="card">
          <h2>รายวัน</h2>
          <div className="bars">
            {rows.map((r) => (
              <div className="row" key={r.d}>
                <div className="day">{dayLabel(r.d)}</div>
                <div className="track">
                  <div className="fill" style={{ width: `${Math.max(1, (r.usd / maxUsd) * 100)}%` }} />
                </div>
                <div className="val">
                  ฿{baht(r.usd, rate)} <span className="hint">· {nf.format(r.n)}</span>
                </div>
              </div>
            ))}
          </div>
          {!rows.length && <div className="empty">ยังไม่มีข้อมูลในช่วงนี้</div>}
        </div>

        <div className="card">
          <h2>ตัวเลขนี้มาจากไหน</h2>
          <div className="note">
            คิดจากจำนวนโทเค็นที่ผู้ให้บริการส่งกลับมาพร้อมทุกคำตอบ คูณกับราคาที่ประกาศไว้ แล้วแปลงเป็นบาทที่{" "}
            <b>฿{rate}/USD</b> (ตั้งใหม่ได้ที่ env <code>USD_THB</code>)
            <br />
            เป็น<b>ประมาณการ ไม่ใช่ใบเสร็จ</b> — ยังไม่หักส่วนลด cached token และถ้าเครื่องดับก่อนเขียนลงฐาน
            ยอดของนาทีนั้นหายไปเลย ตัวเลขจึงมีสิทธิ์คลาดจากบิลจริงได้เล็กน้อย
            <br />
            ยอดที่ถูกเรียกเก็บจริงดูที่{" "}
            <a className="link" href="https://aistudio.google.com/usage" target="_blank" rel="noreferrer">
              aistudio.google.com/usage
            </a>{" "}
            (Gemini) ·{" "}
            <a className="link" href="https://console.groq.com/settings/billing" target="_blank" rel="noreferrer">
              console.groq.com
            </a>{" "}
            (Groq) — ของ Google ช้าราวหนึ่งวัน
            <br />
            เริ่มนับตั้งแต่วันที่ติดตั้งหน้านี้ ก่อนหน้านั้นไม่มีการเก็บไว้ จึงย้อนดูไม่ได้
          </div>
        </div>

        <div className="card">
          <h2>ราคาที่ใช้คำนวณ (USD ต่อ 1 ล้านโทเค็น)</h2>
          <div className="scroll">
            <table style={{ minWidth: 380 }}>
              <thead>
                <tr>
                  <th>รุ่น</th>
                  <th className="num">เข้า</th>
                  <th className="num">ออก</th>
                </tr>
              </thead>
              <tbody>
                {(data?.prices || []).map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td className="num">${p.in}</td>
                    <td className="num">${p.out}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            ตรวจกับหน้าราคาทางการเมื่อ 4 ก.ย. 2569 · ราคาขยับได้ ถ้าผู้ให้บริการเปลี่ยนต้องมาแก้ที่{" "}
            <code>lib/llmUsage.ts</code>
          </div>
        </div>

        {err && <div className="note" style={{ color: "#fbbf24" }}>{err}</div>}
      </div>
    </div>
  );
}

function Gate() {
  const { account, login, getToken } = useM365Auth();
  if (!account) {
    return (
      <div className="mu">
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="center">
          <div className="kick">AI ASSISTANT · ค่า AI</div>
          <div style={{ color: "#8a8a8a", fontSize: 15 }}>ต้องล็อกอิน Microsoft 365 เพื่อดูหน้านี้</div>
          <button onClick={() => login()}>เข้าสู่ระบบ M365</button>
        </div>
      </div>
    );
  }
  return <UsageView getToken={getToken} />;
}

export default function MonitorUsagePage() {
  return (
    <M365AuthProvider>
      <Gate />
    </M365AuthProvider>
  );
}
