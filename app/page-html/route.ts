import { NextResponse } from "next/server";

/** Legacy static index — canonical app is `/` (React shell). */
export async function GET(req: Request) {
  return NextResponse.redirect(new URL("/", req.url), 308);
}
