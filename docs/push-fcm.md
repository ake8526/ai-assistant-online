# แจ้งเตือนขึ้นเครื่องแม้ปิดแอป — สิ่งที่ต้องทำ

ฝั่งเว็บ (รีโปนี้) ทำเสร็จแล้วทั้งหมด เหลือสองอย่างที่ทำในรีโปนี้ไม่ได้:
ใส่ค่า env บน Vercel และสร้าง APK รุ่นใหม่ที่มี Firebase

## โปรเจค Firebase ที่ใช้

| ค่า | |
| --- | --- |
| Project ID | `ktis-x-assistant` |
| Project number | `213681189386` |
| Android package | `com.ktis.aiassistant` |
| Android App ID | `1:213681189386:android:77526d8f0b92a1ab7125f3` |
| แพลน | Spark (ฟรี — FCM ไม่คิดเงิน) |

Google Analytics และ Gemini in Firebase ปิดไว้ ไม่ได้ใช้

## 1. env บน Vercel (ทำก่อน ถึงจะส่งได้)

เอาจาก Firebase console → Project settings → **Service accounts** →
*Generate new private key* จะได้ไฟล์ JSON มาหนึ่งไฟล์ แล้วเอาสามค่านี้ไปใส่

| env | เอามาจากคีย์ไหนใน JSON |
| --- | --- |
| `FCM_PROJECT_ID` | `project_id` (คือ `ktis-x-assistant`) |
| `FCM_CLIENT_EMAIL` | `client_email` |
| `FCM_PRIVATE_KEY` | `private_key` — วางทั้งก้อนรวม `-----BEGIN PRIVATE KEY-----` |

ไฟล์ JSON นั้นคือกุญแจของโปรเจค **อย่า commit ลง git** ใส่ใน Vercel แล้วลบทิ้ง

ยังไม่ใส่ env ระบบก็ทำงานปกติ แค่ไม่มีแจ้งเตือนขึ้นเครื่อง (`lib/push.ts`
เช็คก่อนทุกครั้ง ไม่มีค่าก็ข้ามไปเงียบ ๆ ไม่ทำให้ตัวส่งอื่นพัง)

## 2. APK รุ่นใหม่ต้องทำอะไร

ดาวน์โหลด `google-services.json` จาก Firebase console (Project settings →
General → แอป Android) วางไว้ที่ `app/` ของโปรเจค Android แล้ว

1. ใส่ `firebase-messaging` + plugin `com.google.gms.google-services`
2. ประกาศสิทธิ์ `POST_NOTIFICATIONS` (Android 13 ขึ้นไป) และขอสิทธิ์ตอนเปิดแอป
3. สร้าง notification channel ชื่อ id **`ktisx`** — ฝั่งเซิร์ฟเวอร์ส่งมาที่ช่องนี้
4. เพิ่มสองเมธอดใน JavaScript interface `KtisxApp` (ตัวเดิมที่มี `setKeepAwake`)

```java
@JavascriptInterface
public String getPushToken() {
    // คืนโทเคน FCM ล่าสุด ("" ได้ถ้ายังไม่พร้อม/ไม่อนุญาต)
    return lastFcmToken == null ? "" : lastFcmToken;
}

@JavascriptInterface
public void askNotifyPermission() {
    // ขอสิทธิ์ POST_NOTIFICATIONS — เรียกซ้ำได้ ระบบถามครั้งเดียว
}
```

หน้าเว็บเรียก `getPushToken()` เองตอนเปิดแอป แล้วส่งไปที่
`POST /api/push/register` ให้อัตโนมัติ (`usePushRegister` ใน
`components/Inbox.tsx`) — ฝั่งแอปไม่ต้องยิง API เอง

5. ตอนแตะแจ้งเตือน ให้เปิดแอปแล้วอ่าน `data.open` (ค่าที่ส่งมาคือ `inbox`)
   เพื่อพาไปที่กล่องแจ้งเตือน

### รูปแบบข้อความที่เซิร์ฟเวอร์ส่ง

```json
{
  "message": {
    "token": "<โทเคนของเครื่อง>",
    "notification": { "title": "🌅 สรุปตารางเช้า", "body": "…" },
    "data": { "open": "inbox", "tag": "brief" },
    "android": { "priority": "HIGH", "notification": { "channel_id": "ktisx", "tag": "brief" } }
  }
}
```

`tag` เป็นชนิดของเรื่อง (`brief` / `news` / `task` / `meeting` / `system`)
ใช้ทับแจ้งเตือนเก่าชนิดเดียวกัน จะได้ไม่กองซ้อนกันหลายใบ

## 3. เช็คว่าทำงานไหม

- `GET /api/push/register` คืน `{ configured, devices }` — `configured` บอกว่า
  env ครบหรือยัง `devices` คือจำนวนเครื่องที่ลงทะเบียนไว้ของคนที่เรียก
- ทุกอย่างที่เข้ากล่องแจ้งเตือน (`addNotice`) จะยิง push เองอัตโนมัติ —
  สรุปตารางเช้า ข่าวประจำวัน เตือนงานเลยกำหนด เตือนงานใกล้ถึงกำหนด
- โทเคนที่ FCM ตอบว่าใช้ไม่ได้แล้ว (ถอนแอป/ล้างข้อมูล) ระบบลบทิ้งเอง
