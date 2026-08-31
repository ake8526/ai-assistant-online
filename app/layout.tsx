import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "AI Assistant · KTIS",
  description: "ผู้ช่วยงานประจำวัน KTIS — แชทสั่งงานด้วย Microsoft 365",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="th"
      className={`${geistSans.variable} ${geistMono.variable} ${mali.variable} ${sriracha.variable} ${caveat.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
