import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder-project.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface FeedItem {
  id?: number;
  owner_upn: string;
  kind: "rss" | "youtube" | "facebook";
  ref: string;
  label: string;
  last_seen?: string;
  created_at?: string;
}

export interface ConsentItem {
  owner_upn: string;
  capability: string;
  granted: boolean;
  updated_at?: string;
}
