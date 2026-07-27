import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  console.log(`Read tracking logged for code: ${code}`);
  
  // Default redirect fallback
  const destination = "https://thestandard.co";
  return NextResponse.redirect(destination);
}
