import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.redirect('https://raw.githubusercontent.com/ake8526/ai-assistant-online/main/public/KTISX-AI-Assistant.apk', 302);
}
