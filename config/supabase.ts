import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './env';

loadEnv();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase URL or Service Role Key missing. Backend might not function correctly.');
}

// Service role client for backend operations (bypasses RLS where needed)
export const supabase = createClient(supabaseUrl, supabaseServiceKey);
