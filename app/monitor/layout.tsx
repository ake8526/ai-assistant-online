import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Assistant · Monitor",
};

// Always fetch fresh client bundle for monitor animations.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function MonitorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
