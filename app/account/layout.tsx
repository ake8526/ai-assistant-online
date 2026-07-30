import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "บัญชีของฉัน | AI Assistant",
  description: "ดูบัญชีที่เชื่อมต่อและการอนุญาตติดตามข่าว พร้อมยกเลิกได้",
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return children;
}
