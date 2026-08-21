import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { admin, assertConfigured } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

// GET /api/admin/chat-logs?limit=100&offset=0&search=...
// Fetch persistent chat history entries for viewing on the admin dashboard
export async function GET(req: Request) {
  const gate = await guard(req, "log.view");
  if (!gate.ok) return gate.response;

  try {
    assertConfigured();
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const search = (url.searchParams.get("search") || "").trim();
    const channel = (url.searchParams.get("channel") || "").trim();
    const role = (url.searchParams.get("role") || "").trim();

    let query = admin
      .from("chat_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`content.ilike.%${search}%,user_upn.ilike.%${search}%,session_id.ilike.%${search}%`);
    }
    if (channel) {
      query = query.eq("channel", channel);
    }
    if (role) {
      query = query.eq("role", role);
    }

    const { data, count, error } = await query;

    if (error) {
      // Check if table missing
      if (error.code === "42P01" || error.message?.includes("chat_logs")) {
        return NextResponse.json({
          logs: [],
          total: 0,
          note: "ตาราง chat_logs ยังไม่ถูกสร้าง — กรุณารันไฟล์ supabase/migration_chat_logs.sql ใน Supabase SQL Editor",
        });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      logs: data || [],
      total: count || 0,
      limit,
      offset,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
