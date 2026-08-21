// Create / replace the default LINE Rich Menu (cron or admin).
import { NextResponse } from "next/server";
import { checkCronSecret } from "@/lib/auth";
import { buildRichMenuPng, richMenuObject, RICH_MENU_NAME } from "@/lib/lineRichMenu";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function lineToken(): string {
  const t = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
  if (!t) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  return t;
}

async function lineApi(path: string, init: RequestInit = {}, dataApi = false): Promise<Response> {
  const host = dataApi ? "https://api-data.line.me" : "https://api.line.me";
  return fetch(`${host}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${lineToken()}`,
      ...(init.headers || {}),
    },
  });
}

async function run(req: Request) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const png = await buildRichMenuPng();
    if (png.length > 950_000) {
      return NextResponse.json({ error: `image too large: ${png.length}` }, { status: 500 });
    }

    // Create menu
    const createRes = await lineApi("/v2/bot/richmenu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(richMenuObject()),
    });
    const createBody = await createRes.json().catch(() => ({}));
    if (!createRes.ok) {
      return NextResponse.json({ error: "create failed", detail: createBody }, { status: 502 });
    }
    const richMenuId = createBody.richMenuId as string;
    if (!richMenuId) {
      return NextResponse.json({ error: "no richMenuId", detail: createBody }, { status: 502 });
    }

    // Upload image (content API host)
    const uploadRes = await lineApi(
      `/v2/bot/richmenu/${richMenuId}/content`,
      {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array(png),
      },
      true
    );
    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      return NextResponse.json(
        { error: "upload failed", status: uploadRes.status, detail: detail.slice(0, 400), richMenuId },
        { status: 502 }
      );
    }

    // Set as default
    const defRes = await lineApi(`/v2/bot/user/all/richmenu/${richMenuId}`, { method: "POST" });
    if (!defRes.ok) {
      const detail = await defRes.text();
      return NextResponse.json({ error: "set default failed", detail: detail.slice(0, 300), richMenuId }, { status: 502 });
    }

    // Cleanup older menus with same name prefix (best-effort)
    const listRes = await lineApi("/v2/bot/richmenu/list");
    const listBody = (await listRes.json().catch(() => ({}))) as {
      richmenus?: { richMenuId: string; name?: string }[];
    };
    const old = (listBody.richmenus || []).filter(
      (m) => m.richMenuId !== richMenuId && (m.name || "").startsWith("ktis-main")
    );
    for (const m of old) {
      try {
        await lineApi(`/v2/bot/richmenu/${m.richMenuId}`, { method: "DELETE" });
      } catch {
        /* ignore */
      }
    }

    return NextResponse.json({
      ok: true,
      richMenuId,
      name: RICH_MENU_NAME,
      imageBytes: png.length,
      removedOld: old.map((m) => m.richMenuId),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return run(req);
}

export async function GET(req: Request) {
  return run(req);
}
