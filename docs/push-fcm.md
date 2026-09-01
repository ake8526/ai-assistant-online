# แจ้งเตือนขึ้นเครื่องแม้ปิดแอป (FCM)

ทำเสร็จแล้วทั้งฝั่งเว็บและตัว APK — เหลืออย่างเดียวคือใส่ env บน Vercel

## โปรเจค Firebase

| ค่า | |
| --- | --- |
| Project ID | `ktis-x-assistant` |
| Project number | `213681189386` |
| Android package | `com.ktis.aiassistant` |
| Android App ID | `1:213681189386:android:77526d8f0b92a1ab7125f3` |
| แพลน | Spark (ฟรี — FCM ไม่คิดเงิน) |

Google Analytics และ Gemini in Firebase ปิดไว้ ไม่ได้ใช้

## 1. env บน Vercel (ยังต้องทำ)

Firebase console → Project settings → **Service accounts** → *Generate new private key*
ได้ไฟล์ JSON มา แล้วเอาสามค่านี้ไปใส่ที่ Vercel → Settings → Environment Variables

| env | เอามาจากคีย์ไหนใน JSON |
| --- | --- |
| `FCM_PROJECT_ID` | `project_id` (คือ `ktis-x-assistant`) |
| `FCM_CLIENT_EMAIL` | `client_email` |
| `FCM_PRIVATE_KEY` | `private_key` — วางทั้งก้อนรวม `-----BEGIN PRIVATE KEY-----` |

ใส่แล้วต้อง **Redeploy** ถึงจะมีผล และ **ลบไฟล์ JSON ทิ้ง** อย่า commit

ยังไม่ใส่ env ระบบก็ทำงานปกติ แค่ไม่มีแจ้งเตือนขึ้นเครื่อง (`lib/push.ts` เช็คก่อน
ทุกครั้ง ไม่มีค่าก็ข้ามไปเงียบ ๆ ไม่ทำให้ตัวส่งอื่นพัง)

## 2. APK — ทำเสร็จแล้ว (รุ่น 3.5)

`public/KTISX-AI-Assistant.apk` เป็นรุ่นที่มี Firebase แล้ว เซ็นด้วยกุญแจตัวเดิม
(`db9a73e3…` ตรวจแล้วตรงกับรุ่น 3.4) เครื่องที่ลงอยู่แล้ว **อัปเดตทับได้เลย
ไม่ต้องถอนก่อน**

ในตัวแอปมี:

- `PushService` (FirebaseMessagingService) — รับข้อความและเด้งแจ้งเตือน
  ตอนแอปเปิดอยู่ ส่วนตอนแอปปิด Android เด้งให้เอง
- notification channel id **`ktisx`** ตรงกับที่ `lib/push.ts` ส่งมา
- สะพาน `KtisxApp` เพิ่มสองเมธอด — หน้าเว็บเรียกเองอัตโนมัติ
  (`usePushRegister` ใน `components/Inbox.tsx`) แอปไม่ต้องยิง API เอง

```java
@JavascriptInterface public String getPushToken()      // โทเคน FCM ("" ถ้ายังไม่พร้อม)
@JavascriptInterface public void askNotifyPermission() // ขอสิทธิ์ POST_NOTIFICATIONS (Android 13+)
```

### ซอร์สและวิธี build ใหม่

ซอร์สอยู่ที่ `../android_app` (นอก git เพราะมี keystore กับ google-services.json)

```
cd /c/Users/admin/AppData/Local/Temp/ktisx-apk     # ต้อง build ในพาธที่ไม่มีช่องว่าง
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
/c/Users/admin/.gradle/wrapper/dists/gradle-8.5-bin/*/gradle-8.5/bin/gradle :app:assembleRelease --no-daemon
```

จุดที่เคยพลาด:

- `local.properties` ต้องเขียน `sdk.dir=C:/Users/.../Sdk` แบบ **สแลชหน้า** —
  ใส่ `\` เดี่ยวจะได้ error `Invalid file path` ที่ชี้ไปผิดที่จนหลงทาง
- build ในโฟลเดอร์ที่พาธมีช่องว่าง (`NB AKE`, `AI Assistant`) AGP ล้ม —
  ให้ copy ไป `%TEMP%\ktisx-apk` แล้ว build ที่นั่น
- `versionCode` ต้องเดินหน้าเสมอ (3.4 = 16, 3.5 = 17) ไม่งั้นอัปเดตทับไม่ได้

## 3. เช็คว่าครบหรือยัง

เปิดแอป → **ตั้งค่า** → **ช่วยเหลือ & ระบบ** → **สถานะระบบ** ดูบรรทัด
"แจ้งเตือนขึ้นเครื่อง"

| ขึ้นว่า | แปลว่า |
| --- | --- |
| ยังไม่ได้ตั้งค่า FCM บนเซิร์ฟเวอร์ | ยังไม่ได้ใส่ env หรือยังไม่ redeploy |
| เซิร์ฟเวอร์พร้อมแล้ว แต่ยังไม่มีเครื่องลงทะเบียน | env ถูกแล้ว รอเครื่องที่ลงแอป 3.5 เปิดสักครั้ง |
| พร้อมส่ง · ลงทะเบียนไว้ N เครื่อง | ครบวงจร |

ทุกอย่างที่เข้ากล่องแจ้งเตือน (`addNotice`) ยิง push เองอัตโนมัติ — สรุปตารางเช้า
ข่าวประจำวัน งานเลยกำหนด งานใกล้ถึงกำหนด เตือนก่อนประชุม และนัดใหม่ในปฏิทิน
โทเคนที่ FCM ตอบว่าใช้ไม่ได้แล้ว (ถอนแอป/ล้างข้อมูล) ระบบลบทิ้งเอง
