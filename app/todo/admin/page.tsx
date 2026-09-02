import { TODO_CSS } from "../page-css";

/**
 * ปลายทางหลังแอดมินกด "อนุญาตให้ทั้งองค์กร" สำหรับสิทธิ์ To Do
 *
 * ไม่แตะข้อมูลใคร แค่บอกผลให้แอดมินเห็น — การเปิดใช้ของแต่ละคนยังเป็นคนละเรื่อง
 * และตั้งใจให้แยกกัน อนุมัติสิทธิ์ไม่เท่ากับสั่งให้ทุกคนเริ่มใช้
 */
export const dynamic = "force-dynamic";

export default async function TodoAdminConsent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TODO_CSS }} />
      <div className="wrap">
        <div className="kicker">Microsoft To Do</div>
        {error ? (
          <>
            <h1>ยังไม่ได้อนุมัติ</h1>
            <div className="card bad">
              <p style={{ marginBottom: 0 }}>{error}</p>
            </div>
            <div className="foot">
              ต้องเป็นบัญชีระดับ Global Administrator หรือ Cloud Application Administrator
              จึงจะอนุมัติแทนทั้งองค์กรได้
            </div>
          </>
        ) : (
          <>
            <h1>อนุมัติสิทธิ์ To Do ให้ทั้งองค์กรแล้ว ✅</h1>
            <div className="card ok">
              <p style={{ marginBottom: 0 }}>
                ต่อจากนี้พนักงานที่เคยเข้าใช้ผู้ช่วยแล้วจะได้สิทธิ์ <code>Tasks.ReadWrite</code>{" "}
                ทันที ไม่ต้องกดหน้าขออนุญาตอีก
              </p>
            </div>
            <div className="card">
              <p style={{ marginBottom: 6 }}>ยังไม่มีอะไรเกิดขึ้นกับ To Do ของใคร:</p>
              <ul>
                <li>อนุมัติสิทธิ์ ≠ เปิดใช้งาน — แต่ละคนยังต้องเปิดเอง</li>
                <li>พิมพ์ «เชื่อม todo» ในไลน์เพื่อเปิดของตัวเอง</li>
                <li>เปิดแล้วงานจะเข้าลิสต์ «KTIS X» ใน To Do ของคนนั้น</li>
              </ul>
            </div>
            <div className="foot">ปิดหน้านี้ได้เลยครับ</div>
          </>
        )}
      </div>
    </>
  );
}
