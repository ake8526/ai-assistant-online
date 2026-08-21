import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { admin, assertConfigured } from "@/lib/supabaseServer";
import { searchUsers } from "@/lib/graph";

export const dynamic = "force-dynamic";

// GET /api/admin/chat-logs?limit=100&offset=0&search=...
// Fetch persistent chat history entries for viewing on the admin dashboard
export async function GET(req: Request) {
  const gate = await guard(req, "chat.logs");
  if (!gate.ok) return gate.response;

  try {
    assertConfigured();
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const search = (url.searchParams.get("search") || "").trim();
    const channel = (url.searchParams.get("channel") || "").trim();
    const role = (url.searchParams.get("role") || "").trim();
    const user = (url.searchParams.get("user") || "").trim();
    const date = (url.searchParams.get("date") || "").trim(); // YYYY-MM-DD

    let query = admin
      .from("chat_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // Bangkok timezone offset (+07:00) range calculation
      const dayStart = new Date(`${date}T00:00:00+07:00`).toISOString();
      const dayEnd = new Date(`${date}T23:59:59.999+07:00`).toISOString();
      query = query.gte("created_at", dayStart).lte("created_at", dayEnd);
    }
    if (user) {
      if (!/^[ -~]+$/.test(user)) {
        // Thai nickname search (e.g. บอม) via M365 Graph
        try {
          const hits = await searchUsers(user, 8);
          const mails = hits.filter((h) => h.mail).map((h) => h.mail.toLowerCase());
          if (mails.length > 0) {
            const orConditions = mails.map((m) => `user_upn.ilike.%${m}%,session_id.ilike.%${m}%`).join(",");
            query = query.or(orConditions);
          } else {
            query = query.or(`user_upn.ilike.%${user}%,session_id.ilike.%${user}%`);
          }
        } catch {
          query = query.or(`user_upn.ilike.%${user}%,session_id.ilike.%${user}%`);
        }
      } else {
        query = query.or(`user_upn.ilike.%${user}%,session_id.ilike.%${user}%`);
      }
    }
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
