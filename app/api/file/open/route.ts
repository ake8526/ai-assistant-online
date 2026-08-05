import { getDriveItemWebUrl } from "@/lib/graph";
import { verifyFileOpenToken } from "@/lib/fileOpenLink";

export async function GET(req: Request) {
  const url = new URL(req.url);
  let upn = "";
  try {
    upn = Buffer.from(url.searchParams.get("u") || "", "base64url").toString("utf8");
  } catch {
    return new Response("Invalid link", { status: 400 });
  }
  const fileId = url.searchParams.get("id") || "";
  const exp = Number(url.searchParams.get("e"));
  const sig = url.searchParams.get("s") || "";
  if (!verifyFileOpenToken(upn, fileId, exp, sig)) {
    return new Response("Link expired or invalid", { status: 403 });
  }
  const target = await getDriveItemWebUrl(upn, fileId);
  if (!target) return new Response("File not found", { status: 404 });
  return Response.redirect(target, 302);
}
