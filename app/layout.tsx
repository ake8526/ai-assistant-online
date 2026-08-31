import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Mali, Sriracha, Caveat } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/* ชุดฟอนต์เขียนมือของดีไซน์โน้ตแปะกระดาน */
const mali = Mali({
  variable: "--font-mali",
  subsets: ["latin", "thai"],
  weight: ["400", "500", "600", "700"],
});

const sriracha = Sriracha({
  variable: "--font-sriracha",
  subsets: ["latin", "thai"],
  weight: "400",
});

const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

/** อ่านธีมที่เลือกไว้ก่อน React ทำงาน — คีย์เดียวกับ components/useTheme.ts */
const THEME_BOOT =
  '(function(){try{var t=localStorage.getItem("ktisx_theme");' +
  'if(t==="dark"||t==="light"||t==="auto")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()';

export const metadata: Metadata = {
  title: "AI Assistant · KTIS",
  description: "ผู้ช่วยงานประจำวัน KTIS — แชทสั่งงานด้วย Microsoft 365",
};

/* แถบที่อยู่ของเบราว์เซอร์ให้เป็นสีกระดาน — useTheme สลับค่านี้ตอนเปลี่ยนธีม */
export const viewport: Viewport = { themeColor: "#f1efe9" };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="th"
      data-theme="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${mali.variable} ${sriracha.variable} ${caveat.variable} h-full antialiased`}
    >
      <head>
        {/* ธีมที่ผู้ใช้เลือกต้องมีผลก่อนเบราว์เซอร์วาดจอแรก ไม่งั้นจอแวบขาวก่อนแล้วค่อยมืด
            (วิธีตามคู่มือ Next: docs/01-app/02-guides/preventing-flash-before-hydration.md) */}
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_BOOT,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
