import { hasTasksConsent } from "@/lib/msGraphOAuth";
import { setTodoSyncOn, syncTodoForUser, type TodoSyncResult } from "@/lib/todoSync";
import { verifyConsentToken } from "@/lib/consentLink";
import { TODO_CSS } from "../page-css";

/**
 * หน้าที่เด้งมาหลังกดอนุญาตสิทธิ์ To Do จากลิงก์ในไลน์
 *
 * เปิดได้โดยไม่ต้องล็อกอิน — token ในลิงก์เป็นตัวระบุตัวตน (เซ็น HMAC มีอายุ)
 * แบบเดียวกับหน้าสรุปประชุม /s/[token] เพราะเบราว์เซอร์ในแอป LINE ไม่มีเซสชัน
 * ของเรา
 *
 * หน้านี้ทำงานให้เสร็จในตัว: เปิดสวิตช์ซิงค์ให้เลย แล้วซิงค์รอบแรกทันที ผู้ใช้
 * จึงเห็นผลจริงว่ามีงานเข้า To Do กี่งาน ไม่ใช่แค่ "อนุญาตแล้ว" แล้วต้องไปรอ
 * cron รอบถัดไปโดยไม่รู้ว่าสำเร็จหรือไม่ (กดรีเฟรชซ้ำไม่สร้างงานซ้ำ เพราะ
 * todoSync จำ mapping ไว้)
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: TODO_CSS }} />
      <div className="wrap">
        <div className="kicker">Microsoft To Do</div>
        {children}
      </div>
    </>
  );
}

export default async function TodoReady({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ ms?: string; ms_detail?: string }>;
}) {
  const { token } = await params;
  const { ms, ms_detail } = await searchParams;
  const p = verifyConsentToken(decodeURIComponent(token));

  if (!p) {
    return (
      <Shell>
        <h1>ลิงก์นี้หมดอายุแล้ว</h1>
        <div className="card bad">
          <p style={{ marginBottom: 0 }}>
            พิมพ์ «เชื่อม todo» ในไลน์อีกครั้งเพื่อขอลิงก์ใหม่ได้เลยครับ
          </p>
        </div>
      </Shell>
    );
  }

  if (ms === "denied") {
    return (
      <Shell>
        <h1>ยังไม่ได้อนุญาต</h1>
        <div className="card bad">
          <p style={{ marginBottom: 0 }}>
            คุณกดปฏิเสธในหน้าของ Microsoft — ยังไม่มีงานเข้า To Do ครับ
            เปลี่ยนใจแล้วพิมพ์ «เชื่อม todo» ในไลน์ได้ตลอด
          </p>
        </div>
      </Shell>
    );
  }

  if (ms && ms !== "connected") {
    return (
      <Shell>
        <h1>อนุญาตไม่สำเร็จ</h1>
        <div className="card bad">
          <p>Microsoft ตอบกลับมาว่า: <code>{ms}</code></p>
          {ms_detail && <p style={{ marginBottom: 0 }}>{ms_detail}</p>}
        </div>
        <div className="foot">ลองพิมพ์ «เชื่อม todo» ในไลน์อีกครั้ง ถ้ายังไม่ผ่านให้แจ้ง IT พร้อมข้อความข้างบน</div>
      </Shell>
    );
  }

  /* อนุญาตมาแล้ว — แต่ต้องเช็คว่าสิทธิ์ที่ได้มามี Tasks.ReadWrite จริง
     บางเทเนนต์ตัดสิทธิ์บางตัวออกโดยรอแอดมินอนุมัติ แล้วยังตอบ connected */
  if (!(await hasTasksConsent(p.upn))) {
    return (
      <Shell>
        <h1>ยังไม่ได้สิทธิ์ To Do</h1>
        <div className="card bad">
          <p>
            เข้าสู่ระบบผ่านแล้ว แต่สิทธิ์ที่ได้มายังไม่มี <code>Tasks.ReadWrite</code>
          </p>
          <p style={{ marginBottom: 0 }}>
            มักเกิดจากสองอย่าง — เลือกบัญชีอื่นที่ไม่ใช่ {p.upn} หรือเทเนนต์ตั้งให้สิทธิ์นี้
            ต้องรอแอดมินอนุมัติ ลองอีกครั้งโดยเลือกบัญชีให้ตรง ถ้ายังไม่ผ่านให้แจ้ง IT
          </p>
        </div>
      </Shell>
    );
  }

  await setTodoSyncOn(p.upn, true);
  let res: TodoSyncResult | null = null;
  let err = "";
  try {
    res = await syncTodoForUser(p.upn);
  } catch (e) {
    err = String(e).slice(0, 200);
  }

  if (!res?.ok) {
    return (
      <Shell>
        <h1>อนุญาตเรียบร้อย ✅</h1>
        <div className="card">
          <p style={{ marginBottom: 0 }}>
            เปิดการซิงค์ให้แล้ว แต่รอบแรกยังไม่ผ่าน: {err || res?.reason || "ไม่ทราบสาเหตุ"}
          </p>
        </div>
        <div className="foot">ระบบจะลองใหม่เองในรอบถัดไป หรือพิมพ์ «ซิงค์ todo» ในไลน์เพื่อสั่งเดี๋ยวนี้</div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1>เชื่อม To Do เรียบร้อย ✅</h1>
      <div className="card ok">
        <div className="big">{res.created} งาน</div>
        <p style={{ marginTop: 6, marginBottom: 0 }}>
          ส่งเข้า Microsoft To Do ลิสต์ชื่อ <code>KTIS X</code> แล้ว
        </p>
      </div>
      <div className="card">
        <p style={{ marginBottom: 6 }}>ต่อจากนี้:</p>
        <ul>
          <li>งานใหม่จะเข้า To Do ให้เองอัตโนมัติ</li>
          <li>พิมพ์งานเองในลิสต์ <code>KTIS X</code> ก็เข้ามาที่ผู้ช่วยและไลน์ด้วย</li>
          <li>ติ๊กเสร็จใน To Do แล้ว งานในผู้ช่วยจะปิดตามให้</li>
          <li>ปิดงานในผู้ช่วย งานใน To Do ก็ปิดตาม</li>
          <li>อยากหยุด — พิมพ์ «ปิด todo» ในไลน์</li>
        </ul>
      </div>
      <div className="foot">
        เปิด To Do ได้ที่แอป Microsoft To Do หรือ to-do.office.com ด้วยบัญชี {p.upn}
        <br />
        ปิดหน้านี้แล้วกลับไปที่ไลน์ได้เลยครับ
      </div>
    </Shell>
  );
}
