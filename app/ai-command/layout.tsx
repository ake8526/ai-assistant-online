import { IBM_Plex_Sans_Thai, JetBrains_Mono } from "next/font/google";

/**
 * The root layout loads Geist with `subsets: ["latin"]` — no Thai glyphs — so
 * Thai text falls back to whatever the device picks. Load the same faces the
 * mobile mock used: Plex Sans Thai for words, JetBrains Mono for the
 * machine-side bits (department codes, intent names, timings).
 */
const thai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-thai",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-studio-mono",
  display: "swap",
});

export default function AICommandLayout({ children }: { children: React.ReactNode }) {
  // The app column is phone-width by design. On a desktop window it sits on this
  // backdrop instead of stretching to 1400px, where the command rows turned into
  // long empty bars and the screen read as half-loaded.
  return (
    <div className={`${thai.variable} ${mono.variable} min-h-full bg-[#05070d]`}>{children}</div>
  );
}
