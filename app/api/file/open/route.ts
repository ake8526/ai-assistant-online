import { getDriveItemWebUrl } from "@/lib/graph";
import { verifyFileOpenToken } from "@/lib/fileOpenLink";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") || "";
  const dot = token.lastIndexOf(".");
  if (!token || dot <= 0) return new Response("Invalid link", { status: 400 });
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let payload = "";
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return new Response("Invalid link", { status: 400 });
  }

  const parts = payload.split("|");
  const upn = parts[0] || "";
  const fileId = parts[1] || "";
  const exp = Number(parts[2] || 0);

  if (!verifyFileOpenToken(upn, fileId, exp, sig)) {
    return new Response("Link expired or invalid", { status: 403 });
  }
  const target = await getDriveItemWebUrl(upn, fileId);
  if (!target) return new Response("File not found", { status: 404 });
  return Response.redirect(target, 302);
}
