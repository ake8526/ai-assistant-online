import { NextResponse } from "next/server";

/** Legacy static mobile UI — canonical app is `/` (React shell). */
export async function GET(req: Request) {
  return NextResponse.redirect(new URL("/", req.url), 308);
}
