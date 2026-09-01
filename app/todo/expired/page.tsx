import { TODO_CSS } from "../page-css";

/** ลิงก์อนุญาต To Do ที่หมดอายุหรือถูกแก้ — เปิดจากไลน์ ไม่ต้องล็อกอิน */
export const dynamic = "force-dynamic";

export default async function TodoExpired({
  searchParams,
}: {
  searchParams: Promise<{ why?: string }>;
}) {
  const { why } = await searchParams;
  const oauth = why === "oauth";
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TODO_CSS }} />
      <div className="wrap">
        <div className="kicker">KTIS X</div>
        <h1>{oauth ? "ระบบยังตั้งค่าไม่ครบ" : "ลิงก์นี้หมดอายุแล้ว"}</h1>
        <div className="card bad">
          <p style={{ marginBottom: 0 }}>
            {oauth
              ? "ฝั่งเซิร์ฟเวอร์ยังไม่ได้ตั้งค่าการเชื่อม Microsoft — แจ้ง IT ให้ตรวจ env GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET ครับ"
              : "ลิงก์ขออนุญาตมีอายุ 30 นาทีเพื่อความปลอดภัย พิมพ์ «เชื่อม todo» ในไลน์อีกครั้งเพื่อขอลิงก์ใหม่ได้เลยครับ"}
          </p>
        </div>
        <div className="foot">ปิดหน้านี้แล้วกลับไปที่ไลน์ได้เลย</div>
      </div>
    </>
  );
}
