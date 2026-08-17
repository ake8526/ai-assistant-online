import { loadSummaryPage, readSummaryToken } from "@/lib/summaryPage";

// The page a meeting-summary link opens. Read on a phone straight from LINE,
// so: one column, generous type, no login step. The token in the URL is the
// credential — signed and expiring, the same scheme file links already use.
export const dynamic = "force-dynamic";

const CSS = `
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e0f;color:#ececec;font-family:'IBM Plex Sans Thai','Segoe UI',system-ui,sans-serif;
  line-height:1.75;padding:18px 16px 60px}
.wrap{max-width:680px;margin:0 auto}
.kicker{color:#ee1b24;font-size:13px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px}
h1{font-size:23px;line-height:1.35;font-weight:700;margin-bottom:6px}
.when{color:#9a9a9a;font-size:15px;margin-bottom:20px}
.card{background:#171718;border:1px solid #2a2a2c;border-radius:12px;padding:16px 16px 18px;margin-bottom:14px}
.card h2{font-size:14px;color:#9a9a9a;font-weight:600;letter-spacing:.06em;margin-bottom:10px}
pre.body{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:16.5px}
pre.body a,.card a{color:#7dd3fc}
ul{margin-left:20px}
li{margin-bottom:7px;font-size:16.5px}
.foot{color:#6f6f6f;font-size:13px;margin-top:26px;line-height:1.6}
.gone{background:#171718;border:1px solid #7f1d1d;border-radius:12px;padding:22px;text-align:center}
.gone h1{font-size:19px;color:#ee1b24;margin-bottom:8px}
.gone p{color:#9a9a9a;font-size:15px}
`;

function linkify(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`
  );
}

export default async function SummaryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = readSummaryToken(decodeURIComponent(token));
  const data = id ? await loadSummaryPage(id) : null;

  if (!data) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="wrap">
          <div className="gone">
            <h1>เปิดสรุปนี้ไม่ได้</h1>
            <p>ลิงก์หมดอายุหรือไม่ถูกต้องครับ — ลิงก์สรุปประชุมมีอายุ 30 วัน</p>
            <p style={{ marginTop: 10 }}>พิมพ์ «สรุปประชุม» ใน LINE เพื่อขอสรุปล่าสุดอีกครั้งได้</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <div className="kicker">สรุปประชุม</div>
        <h1>{data.subject}</h1>
        {data.when && <div className="when">🕐 {data.when}</div>}

        <div className="card">
          <h2>สรุปการประชุม</h2>
          <pre className="body" dangerouslySetInnerHTML={{ __html: linkify(data.text) }} />
        </div>

        {!!data.actionItems?.length && (
          <div className="card">
            <h2>สิ่งที่ต้องทำต่อ · {data.actionItems.length} รายการ</h2>
            <ul>
              {data.actionItems.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="foot">
          สรุปโดย AI Assistant · KTIS Group
          <br />
          ลิงก์นี้เปิดได้ถึง 30 วันหลังการประชุม — โปรดอย่าส่งต่อให้คนนอกที่ประชุม
        </div>
      </div>
    </>
  );
}
