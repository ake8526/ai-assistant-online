// Turns a brief into LINE message objects your (or your senior's) LINE client
// can push directly:  client.pushMessage({ to, messages })

export function quietDayText() {
  return (
    "☕ Tech Brief — วันนี้ข่าวเทคเงียบ\n" +
    "ยังไม่มีข่าวเด่นจากสำนักข่าวที่คัดไว้ผ่านเกณฑ์ในรอบ 24 ชม.\n" +
    "ระบบทำงานปกติ เดี๋ยวพรุ่งนี้เช้ามาใหม่ครับ"
  );
}

/**
 * @param {{ quietDay:boolean, imageUrl?:string|null }} args
 * @returns LINE `messages` array (image message, or quiet-day text)
 */
export function toLineMessages({ quietDay, imageUrl }) {
  if (quietDay || !imageUrl) {
    return [{ type: "text", text: quietDayText() }];
  }
  return [
    {
      type: "image",
      originalContentUrl: imageUrl,
      previewImageUrl: imageUrl,
    },
  ];
}
