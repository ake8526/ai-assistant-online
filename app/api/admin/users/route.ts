import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { searchUsers } from "@/lib/graph";

// People picker for /monitor/admin — search the M365 directory by nickname or
// name so granting access does not mean typing an address from memory. Reuses
// the same lookup the assistant uses for "ดูตารางเบส", nickname spellings and
// all. Admin-only: the directory is not something a viewer needs to browse.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await guard(req, "admin");
  if (!gate.ok) return gate.response;

  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ users: [] });

  try {
    const found = await searchUsers(q, 8);
    return NextResponse.json({
      users: found
        .filter((u) => u.mail)
        .map((u) => ({ mail: u.mail.toLowerCase(), name: u.displayName || u.mail })),
    });
  } catch (e) {
    return NextResponse.json({ users: [], error: String(e).slice(0, 150) }, { status: 200 });
  }
}
