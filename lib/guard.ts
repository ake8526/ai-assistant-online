// One place that answers "may this request do that?" for the ops routes.
//
// Local `next dev` stays open so the pages can be worked on without a login,
// exactly as the monitor feeds already did; in production every call needs a
// verified M365 token AND the named permission.
import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { can, permsOf, type Perm } from "@/lib/roles";

const REQUIRE_LOGIN = process.env.NODE_ENV === "production";

export type Guarded =
  | { ok: true; upn: string; perms: Perm[] }
  | { ok: false; response: NextResponse };

export async function guard(req: Request, perm: Perm): Promise<Guarded> {
  if (!REQUIRE_LOGIN) {
    const { PERMS } = await import("@/lib/roles");
    return { ok: true, upn: "dev", perms: PERMS.map((p) => p.key) };
  }

  let upn: string;
  try {
    upn = await requireUser(req);
  } catch (e) {
    const msg = e instanceof AuthError ? e.message : "auth failed";
    return { ok: false, response: NextResponse.json({ error: msg }, { status: 401 }) };
  }

  if (!(await can(upn, perm))) {
    // 403, not 401 — the client must not send the user back to sign in again
    // for a permission that signing in will not grant.
    return {
      ok: false,
      response: NextResponse.json(
        { error: "forbidden", need: perm, upn },
        { status: 403 }
      ),
    };
  }

  return { ok: true, upn, perms: await permsOf(upn) };
}
