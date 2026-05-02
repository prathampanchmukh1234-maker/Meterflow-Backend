import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { auditLog, formatResponse, formatError } from '../utils/helpers';

async function calculateCurrentInvoice(userId: string) {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const { count } = await supabase
    .from('usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('timestamp', periodStart.toISOString());

  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('plans(free_quota, price_per_100_requests)')
    .eq('id', userId)
    .single();

  if (userError) throw new Error(userError.message);

  const plan = (userData as any)?.plans;
  if (!plan) throw new Error('No active plan found for this user');

  const totalRequests = count || 0;
  const freeQuotaUsed = Math.min(totalRequests, plan.free_quota || 0);
  const billableRequests = Math.max(0, totalRequests - (plan.free_quota || 0));
  const amount = (billableRequests / 100) * Number(plan.price_per_100_requests || 0);

  const invoicePayload = {
      user_id: userId,
      period_start: periodStart.toISOString(),
      period_end: now.toISOString(),
      total_requests: totalRequests,
      free_quota_used: freeQuotaUsed,
      billable_requests: billableRequests,
      amount_inr: amount,
      status: amount > 0 ? 'pending' : 'paid',
    };

  const { data: existing, error: existingError } = await supabase
    .from('billing')
    .select('id')
    .eq('user_id', userId)
    .eq('period_start', periodStart.toISOString())
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);

  const query = existing
    ? supabase.from('billing').update(invoicePayload).eq('id', existing.id)
    : supabase.from('billing').insert([invoicePayload]);

  const { data, error } = await query
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export const getPlans = async (_req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('free_quota', { ascending: true });

  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(data));
};

export const getBillingHistory = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { data, error } = await supabase
    .from('billing')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(data));
};

export const getCurrentUsage = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const { count } = await supabase
    .from('usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('timestamp', start.toISOString());

  const { data: userData } = await supabase
    .from('users')
    .select('plan_id, plans(name, free_quota, price_per_100_requests, rate_limit_per_minute, monthly_price_inr)')
    .eq('id', user.id)
    .single();

  res.json(formatResponse({
    requests_this_month: count || 0,
    plan_id: (userData as any)?.plan_id,
    plan: (userData as any)?.plans,
  }));
};

export const generateCurrentInvoice = async (req: Request, res: Response) => {
  const user = (req as any).user;

  try {
    const invoice = await calculateCurrentInvoice(user.id);
    await auditLog(supabase, user.id, 'billing.invoice_generated', { billing_id: invoice.id });
    res.status(201).json(formatResponse(invoice, 'Current invoice generated'));
  } catch (error: any) {
    res.status(500).json(formatError(error.message));
  }
};

export const changePlan = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { plan_id } = req.body;

  if (!plan_id) return res.status(400).json(formatError('plan_id is required'));

  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('id, name, monthly_price_inr')
    .eq('id', plan_id)
    .single();

  if (planError || !plan) return res.status(404).json(formatError('Plan not found'));
  if (Number(plan.monthly_price_inr || 0) > 0) {
    return res.status(402).json(formatError('Paid plans require payment verification before activation', 402));
  }

  const { data, error } = await supabase
    .from('users')
    .update({ plan_id })
    .eq('id', user.id)
    .select('id, email, role, plan_id, plans(name, free_quota, price_per_100_requests, rate_limit_per_minute, monthly_price_inr)')
    .single();

  if (error) return res.status(500).json(formatError(error.message));

  await auditLog(supabase, user.id, 'plan.changed', { plan_id, plan_name: plan.name });
  res.json(formatResponse(data, `Plan changed to ${plan.name}`));
};

export const getAllBillingHistory = async (req: Request, res: Response) => {
  // Admin only — no user_id filter
  const { data, error } = await supabase
    .from('billing')
    .select('*, users(email)')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(data));
};
