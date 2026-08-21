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
  const { admin, assertConfigured } = await import("../lib/supabaseServer");
  assertConfigured();
  const { data, error } = await admin.from("line_links").select("upn, display_name, line_user_id");
  if (error) throw error;
  for (const row of data || []) {
    console.log(JSON.stringify(row));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
