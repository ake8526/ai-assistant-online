import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { searchUsers } from "@/lib/graph";

export const dynamic = "force-dynamic";

// GET /api/users/search?q=...
// Autocomplete/search M365 directory users by name or nickname
export async function GET(req: Request) {
  const gate = await guard(req, "log.view");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q || q.length < 1) {
    return NextResponse.json({ users: [] });
  }

  try {
    const hits = await searchUsers(q, 10);
    const users = hits
      .filter((u) => u.mail)
      .map((u) => ({
        mail: u.mail.toLowerCase(),
        name: u.displayName || u.mail,
      }));
    return NextResponse.json({ users });
  } catch (e) {
    return NextResponse.json({ users: [], error: String(e).slice(0, 100) });
  }
}
