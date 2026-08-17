import { loadNewsPage, readNewsToken } from "@/lib/newsPage";

// The morning news, read on a phone from LINE. Each story keeps its source
// link — the point of moving news out of chat was to stop truncating it, not
// to hide where it came from.
export const dynamic = "force-dynamic";

const CSS = `
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e0f;color:#ececec;font-family:'IBM Plex Sans Thai','Segoe UI',system-ui,sans-serif;
  line-height:1.7;padding:18px 16px 60px}
.wrap{max-width:680px;margin:0 auto}
.kicker{color:#ee1b24;font-size:13px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:4px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
.date{color:#9a9a9a;font-size:15px;margin-bottom:20px}
article{background:#171718;border:1px solid #2a2a2c;border-radius:12px;padding:15px 15px 16px;margin-bottom:12px}
.topic{color:#f0b429;font-size:13px;letter-spacing:.05em;margin-bottom:5px}
h2{font-size:17.5px;line-height:1.45;font-weight:600;margin-bottom:9px}
ul{margin:0 0 12px 19px}
li{margin-bottom:6px;font-size:16px;color:#d4d4d4}
a.src{display:inline-block;color:#7dd3fc;font-size:15px;text-decoration:none;border:1px solid #1e3a8a;
  border-radius:8px;padding:4px 11px}
a.src:hover{background:rgba(125,211,252,.1)}
.empty{background:#171718;border:1px solid #2a2a2c;border-radius:12px;padding:22px;text-align:center;color:#9a9a9a}
.foot{color:#6f6f6f;font-size:13px;margin-top:24px;line-height:1.6}
.gone{background:#171718;border:1px solid #7f1d1d;border-radius:12px;padding:22px;text-align:center}
.gone h1{font-size:19px;color:#ee1b24;margin-bottom:8px}
.gone p{color:#9a9a9a;font-size:15px}
`;

export default async function NewsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = readNewsToken(decodeURIComponent(token));
  const data = id ? await loadNewsPage(id) : null;

  if (!data) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="wrap">
          <div className="gone">
            <h1>เปิดหน้าข่าวนี้ไม่ได้</h1>
            <p>ลิงก์หมดอายุหรือไม่ถูกต้องครับ — ลิงก์ข่าวมีอายุ 30 วัน</p>
            <p style={{ marginTop: 10 }}>พิมพ์ «ข่าววันนี้» ใน LINE เพื่อขอข่าวล่าสุดได้</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="wrap">
        <div className="kicker">ข่าวเช้า</div>
        <h1>ข่าวที่ติดตาม · {data.stories.length} เรื่อง</h1>
        <div className="date">{data.dateLabel}</div>

        {!data.stories.length && (
          <div className="empty">{data.note || "วันนี้ยังไม่มีข่าวใหม่จากแหล่งที่ติดตามครับ"}</div>
        )}

        {data.stories.map((s, i) => (
          <article key={i}>
            {s.topic && <div className="topic">{s.topic}</div>}
            <h2>{s.headline}</h2>
            {!!s.points.length && (
              <ul>
                {s.points.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ul>
            )}
            {s.link && (
              <a className="src" href={s.link} target="_blank" rel="noopener noreferrer">
                อ่านต้นฉบับ ↗
              </a>
            )}
          </article>
        ))}

        <div className="foot">
          สรุปโดย AI Assistant · KTIS Group
          <br />
          แก้แหล่งข่าวที่ติดตามได้โดยพิมพ์ «ตั้งค่าข่าว» ใน LINE
        </div>
      </div>
    </>
  );
}
