import type { Metadata } from "next";
import { HELP_TIPS, HELP_TOPICS, LINE_OA_ID, helpUrl, sendToLineUrl } from "@/lib/help";

// The manual, as a page a colleague can be sent a link to.
//
// Read on a phone, from inside LINE: one column, no login, no build step. Every
// command is a link back into the chat with the text already typed, because the
// distance between "I read that I can do this" and "I did it" should be one tap.
// Content comes from lib/help.ts so the page cannot drift from what the
// assistant actually understands.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "พิมพ์อะไรได้บ้าง · KTIS X AI Assistant",
  description:
    "คู่มือคำสั่งทั้งหมดของผู้ช่วย AI — ดูตาราง จองประชุม สรุปประชุม งานที่ต้องตาม ไฟล์ ข่าว และการเดินทาง แตะคำสั่งเพื่อส่งเข้าแชทได้เลย",
  openGraph: {
    title: "พิมพ์อะไรได้บ้าง · KTIS X AI Assistant",
    description: "คู่มือคำสั่งทั้งหมด — แตะคำสั่งเพื่อส่งเข้าแชทได้เลย",
    url: helpUrl(),
    type: "website",
  },
};

const CSS = `
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0b1017;color:#eef2f7;
  font-family:'IBM Plex Sans Thai','Segoe UI',system-ui,sans-serif;line-height:1.6}
.wrap{max-width:680px;margin:0 auto;padding:18px 16px 70px}

.head{padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,.10)}
.kk{color:#06C755;font-size:11.5px;font-weight:700;letter-spacing:.16em}
h1{font-size:26px;font-weight:700;letter-spacing:-.01em;margin:5px 0 7px}
.head p{color:#93a2b5;font-size:14.5px}
.head p b{color:#eef2f7}

.jump{display:flex;flex-wrap:wrap;gap:7px;margin:16px 0 4px}
.jump a{text-decoration:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
  color:#dbe4ee;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600}

.cat{padding:18px 0 16px;border-bottom:1px solid rgba(255,255,255,.10)}
.cat h2{font-size:17.5px;font-weight:700;display:flex;gap:9px;align-items:center;scroll-margin-top:12px}
.cat h2 span{font-size:20px}
.cat .hint{color:#93a2b5;font-size:13.5px;margin:5px 0 11px 30px}
.cmds{display:flex;flex-wrap:wrap;gap:7px;margin-left:30px}
.cmds a{display:inline-flex;align-items:center;gap:6px;text-decoration:none;
  background:rgba(6,199,85,.10);border:1px solid rgba(6,199,85,.45);color:#d6ffe6;
  border-radius:999px;padding:7px 13px;font-size:14px;font-weight:600}
.cmds a:active{background:rgba(6,199,85,.28)}
.cmds a i{font-style:normal;font-size:9px;color:#06C755}
.note{margin:11px 0 0 30px;color:#93a2b5;font-size:13px;
  border-left:2px solid rgba(255,255,255,.14);padding-left:11px}

.tips{margin-top:20px;background:rgba(215,161,58,.08);border:1px solid rgba(215,161,58,.28);
  border-radius:14px;padding:14px 16px}
.tips h3{font-size:15px;font-weight:700;color:#f0c56a;margin-bottom:8px}
.tips li{list-style:none;color:#cfd8e3;font-size:13.5px;padding-left:15px;position:relative;margin:6px 0}
.tips li:before{content:"";position:absolute;left:0;top:8px;width:5px;height:5px;border-radius:50%;
  background:#d7a13a;opacity:.85}

.foot{margin-top:22px;color:#6f7e91;font-size:12.5px}
.foot b{color:#93a2b5}
.back{display:block;margin-top:18px;text-align:center;text-decoration:none;
  background:#06C755;color:#04240f;font-weight:700;border-radius:12px;padding:13px;font-size:15px}
`;

export default function HelpPage() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <div className="head">
          <div className="kk">KTIS X · AI ASSISTANT</div>
          <h1>พิมพ์อะไรได้บ้าง</h1>
          <p>
            พิมพ์ภาษาไทยธรรมดา ไม่ต้องจำรูปแบบ · <b>แตะคำสั่งเพื่อส่งเข้าแชทได้เลย</b>
          </p>
          <div className="jump">
            {HELP_TOPICS.map((t) => (
              <a key={t.key} href={`#${t.key}`}>
                {t.emoji} {t.title}
              </a>
            ))}
          </div>
        </div>

        {HELP_TOPICS.map((t) => (
          <div className="cat" key={t.key}>
            <h2 id={t.key}>
              <span>{t.emoji}</span>
              {t.title}
            </h2>
            <div className="hint">{t.hint}</div>
            <div className="cmds">
              {t.commands.map((c) => (
                <a key={c.text} href={sendToLineUrl(c.text)}>
                  <i>▶</i>
                  {c.text}
                </a>
              ))}
            </div>
            {t.note && <div className="note">{t.note}</div>}
          </div>
        ))}

        <div className="tips">
          <h3>💡 เกร็ดที่ทำให้ใช้ง่ายขึ้น</h3>
          <ul>
            {HELP_TIPS.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>

        <a className="back" href={`https://line.me/R/ti/p/${encodeURIComponent(LINE_OA_ID)}`}>
          กลับไปแชทกับผู้ช่วย →
        </a>

        <div className="foot">
          <b>KTIS X AI Assistant</b> · ผู้ช่วยงานประจำวัน ต่อกับ Microsoft 365 ของบริษัท ·
          ต้องล็อกอิน M365 และอนุญาตปฏิทินก่อนใช้งานดูตาราง ·
          ถามอะไรก็ได้ในแชท ถ้าไม่เจอคำสั่งที่ต้องการ
        </div>
      </div>
    </>
  );
}
