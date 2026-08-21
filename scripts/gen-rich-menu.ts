import { buildRichMenuPng } from "../lib/lineRichMenu";
import sharp from "sharp";
import fs from "fs";

async function main() {
  const buf = await buildRichMenuPng({ force: true });
  const meta = await sharp(buf).metadata();
  console.log({ bytes: buf.length, width: meta.width, height: meta.height, format: meta.format });
  fs.writeFileSync("assets/line-rich-menu.png", buf);
  fs.writeFileSync("assets/rich-menu-test.png", buf);
  console.log("wrote assets/line-rich-menu.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
