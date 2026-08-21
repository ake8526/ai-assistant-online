import fs from "fs";
import path from "path";

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
  if (!token) throw new Error("no token");
  const h = { Authorization: `Bearer ${token}` };

  const def = await fetch("https://api.line.me/v2/bot/user/all/richmenu", { headers: h });
  console.log("default", def.status, await def.text());

  const list = await fetch("https://api.line.me/v2/bot/richmenu/list", { headers: h });
  const body = (await list.json()) as {
    richmenus?: { richMenuId: string; name?: string; selected?: boolean; chatBarText?: string; size?: unknown }[];
  };
  console.log(
    "menus",
    (body.richmenus || []).map((m) => ({
      id: m.richMenuId,
      name: m.name,
      selected: m.selected,
      chatBarText: m.chatBarText,
      size: m.size,
    }))
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
