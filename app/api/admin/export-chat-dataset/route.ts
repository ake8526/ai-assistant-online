import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { exportChatLogsJsonl } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 60;

// GET /api/admin/export-chat-dataset?limit=1000
// Export chat history in OpenAI JSONL format for LLM Fine-tuning
export async function GET(req: Request) {
  try {
    assertConfigured();
    const upn = await requireUser(req);
    
    // Check if limit query parameter is passed
    const { searchParams } = new URL(req.url);
    const limit = searchParams.get("limit") ? parseInt(searchParams.get("limit")!, 10) : undefined;
    const startDate = searchParams.get("startDate") || undefined;

    const jsonlData = await exportChatLogsJsonl({
      limitSessions: limit,
      startDate,
    });

    return new Response(jsonlData, {
      status: 200,
      headers: {
        "Content-Type": "application/x-jsonlines; charset=utf-8",
        "Content-Disposition": `attachment; filename="chat_dataset_${new Date().toISOString().slice(0, 10)}.jsonl"`,
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
