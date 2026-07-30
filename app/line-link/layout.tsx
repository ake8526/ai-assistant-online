import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ผูกบัญชี Microsoft 365 กับ LINE",
  description: "เชื่อมบัญชี Microsoft 365 กับ LINE เพื่อรับสรุปประชุม งานที่ได้รับมอบหมาย และการแจ้งเตือน",
};

export default function LineLinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
