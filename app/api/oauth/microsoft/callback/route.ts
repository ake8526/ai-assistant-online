import { NextResponse } from "next/server";
import { exchangeMicrosoftCode, saveMicrosoftToken } from "@/lib/msGraphOAuth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const err = url.searchParams.get("error");
  const stateRaw = url.searchParams.get("state") || "";

  let back = "/account";
  let upn = "";
  try {
    const state = JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf-8")) as {
      upn?: string;
      back?: string;
    };
    upn = (state.upn || "").toLowerCase();
    if (state.back?.startsWith("/")) back = state.back;
  } catch { /* bad state */ }

  const dest = (q: string) => NextResponse.redirect(`${url.origin}${back}?ms=${q}`);

  if (err) return dest(err === "access_denied" ? "denied" : "error");
  if (!code || !upn) return dest("error");

  try {
    const tok = await exchangeMicrosoftCode(code);
    if (!tok.refresh_token) return dest("no_refresh");
    await saveMicrosoftToken(upn, tok.refresh_token, tok.scope, upn);
    return dest("connected");
  } catch (e) {
    console.error("[ms-oauth] callback", e);
    return dest("error");
  }
}
