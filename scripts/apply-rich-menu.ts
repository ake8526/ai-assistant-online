import fs from "fs";
import path from "path";
import { buildRichMenuPng, richMenuObject, RICH_MENU_NAME } from "../lib/lineRichMenu";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadEnvLocal();
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN missing");

  const png = await buildRichMenuPng({ force: true });
  console.log({ name: RICH_MENU_NAME, bytes: png.length });

  const createRes = await fetch("https://api.line.me/v2/bot/richmenu", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(richMenuObject()),
  });
  const createBody = (await createRes.json()) as { richMenuId?: string; message?: string };
  console.log("create", createRes.status, createBody);
  if (!createRes.ok || !createBody.richMenuId) process.exit(1);
  const id = createBody.richMenuId;

  const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
    body: new Uint8Array(png),
  });
  console.log("upload", uploadRes.status, (await uploadRes.text()).slice(0, 200));
  if (!uploadRes.ok) process.exit(1);

  const defRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("default", defRes.status, (await defRes.text()).slice(0, 200));
  if (!defRes.ok) process.exit(1);

  const listRes = await fetch("https://api.line.me/v2/bot/richmenu/list", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await listRes.json()) as { richmenus?: { richMenuId: string; name?: string }[] };
  const old = (list.richmenus || []).filter(
    (m) => m.richMenuId !== id && (m.name || "").startsWith("ktis-main")
  );
  for (const m of old) {
    const d = await fetch(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log("deleted", m.name, m.richMenuId, d.status);
  }
  console.log("ok", id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
