import { NextResponse } from "next/server";

const HOME_HTML_SRC =
  "https://raw.githubusercontent.com/ake8526/ai-assistant-online/main/public/system-functions.html";

export async function GET() {
  const res = await fetch(HOME_HTML_SRC, { next: { revalidate: 60 } });
  if (!res.ok) {
    return new NextResponse("Home page unavailable", { status: 502 });
  }
  const html = await res.text();
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
