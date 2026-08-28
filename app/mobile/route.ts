import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "public", "mobile.html");
    if (fs.existsSync(filePath)) {
      const html = fs.readFileSync(filePath, "utf-8");
      return new NextResponse(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, must-revalidate",
        },
      });
    }
    return new NextResponse("Mobile app page not found", { status: 404 });
  } catch {
    return new NextResponse("Failed to load mobile app page", { status: 500 });
  }
}
