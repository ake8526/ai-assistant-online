import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { exportChatLogsJsonl } from "@/lib/store";
import { assertConfigured } from "@/lib/supabaseServer";

export const maxDuration = 60;

// GET /api/admin/export-chat-dataset?limit=1000
// Export chat history in OpenAI JSONL format for LLM Fine-tuning
export async function GET(req: Request) {
  const gate = await guard(req, "chat.logs");
  if (!gate.ok) return gate.response;

  try {
    assertConfigured();
    
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
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
