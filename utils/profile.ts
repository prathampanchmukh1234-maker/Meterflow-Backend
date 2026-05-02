import { supabase } from '../config/supabase';

const VALID_ROLES = ['admin', 'api_owner', 'consumer'];

export async function ensureUserProfile(authUser: any) {
  const { data: existing, error: fetchError } = await supabase
    .from('users')
    .select('id, email, name, role, plan_id, created_at, plans(name, free_quota, price_per_100_requests, rate_limit_per_minute, monthly_price_inr)')
    .eq('id', authUser.id)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (existing) return existing;

  const requestedRole = VALID_ROLES.includes(authUser.user_metadata?.role)
    ? authUser.user_metadata.role
    : 'api_owner';
  const fallbackName = authUser.user_metadata?.name || authUser.email?.split('@')[0] || null;

  const { data: freePlan } = await supabase
    .from('plans')
    .select('id')
    .eq('name', 'Free')
    .maybeSingle();

  const { data: created, error: createError } = await supabase
    .from('users')
    .upsert(
      [{
        id: authUser.id,
        email: authUser.email,
        name: fallbackName,
        role: requestedRole,
        ...(freePlan?.id ? { plan_id: freePlan.id } : {}),
      }],
      { onConflict: 'id' }
    )
    .select('id, email, name, role, plan_id, created_at, plans(name, free_quota, price_per_100_requests, rate_limit_per_minute, monthly_price_inr)')
    .single();

  if (createError) throw new Error(createError.message);
  return created;
}
