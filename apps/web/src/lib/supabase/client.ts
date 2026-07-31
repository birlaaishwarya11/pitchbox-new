import { createBrowserClient } from '@supabase/ssr';

/**
 * Supabase client for use in Client Components (browser). Reads the public
 * URL + anon/publishable key — never the secret/service_role key.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
