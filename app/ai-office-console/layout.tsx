import { IBM_Plex_Mono, IBM_Plex_Sans_Thai } from "next/font/google";

/**
 * The app's root layout loads Geist with `subsets: ["latin"]` — no Thai glyphs —
 * and globals.css falls back to Arial, so every Thai word on this page was drawn
 * by whatever face the OS happened to pick. The LINE-facing pages (/help, /s,
 * /n, /monitor) already standardise on IBM Plex Sans Thai; this loads the same
 * family properly, self-hosted by next/font.
 *
 * Plex Mono joins it for the parts of a console that are machine-side — command
 * echo, timings, intent names, keyboard hints. Keeping those in mono is what
 * separates "the operator typed this" from "the assistant said this" without
 * needing a box around either.
 */
const plexThai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600"],
  variable: "--font-thai",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-console-mono",
  display: "swap",
});

export default function AIOfficeConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`${plexThai.variable} ${plexMono.variable} min-h-full`}>{children}</div>
  );
}
