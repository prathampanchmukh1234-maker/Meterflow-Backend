import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { formatResponse, formatError } from '../utils/helpers';

export const getUsageStats = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { timeframe } = req.query; // '24h', '7d', '30d'
  
  let dateFilter = new Date();
  if (timeframe === '24h') dateFilter.setHours(dateFilter.getHours() - 24);
  else if (timeframe === '7d') dateFilter.setDate(dateFilter.getDate() - 7);
  else dateFilter.setDate(dateFilter.getDate() - 30);

  // Aggregated usage by day
  const { data: dailyUsage, error: dailyError } = await supabase
    .rpc('get_daily_usage', { 
      user_id_param: user.id, 
      start_date: dateFilter.toISOString() 
    });

  if (dailyError) return res.status(500).json(formatError(dailyError.message));

  // Response summary
  const { count: totalRequests } = await supabase
    .from('usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('timestamp', dateFilter.toISOString());

  const { count: errorCount } = await supabase
    .from('usage_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('timestamp', dateFilter.toISOString())
    .gte('response_status', 400);

  const finalTotal = totalRequests || 0;
  const finalErrors = errorCount || 0;
  const successCount = finalTotal - finalErrors;

  res.json(formatResponse({
    dailyUsage,
    summary: {
      totalRequests: finalTotal,
      successCount,
      errorCount: finalErrors,
      errorRate: finalTotal > 0 ? (finalErrors / finalTotal) * 100 : 0
    }
  }));
};

export const getTopEndpoints = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { data, error } = await supabase
    .rpc('get_top_endpoints', { user_id_param: user.id });

  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(data));
};

export const getRequestLogs = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { page = 1, limit = 50, status, key_id, timeframe = '24h' } = req.query;

  const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));

  let dateFilter = new Date();
  if (timeframe === '24h') dateFilter.setHours(dateFilter.getHours() - 24);
  else if (timeframe === '7d') dateFilter.setDate(dateFilter.getDate() - 7);
  else dateFilter.setDate(dateFilter.getDate() - 30);

  let query = supabase
    .from('usage_logs')
    .select('*, api_keys(key_prefix)', { count: 'exact' })
    .eq('user_id', user.id)
    .gte('timestamp', dateFilter.toISOString())
    .order('timestamp', { ascending: false })
    .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);

  if (status && status !== '') {
    const statusCode = parseInt(status as string, 10);
    if (isNaN(statusCode)) {
      return res.status(400).json(formatError('Invalid status filter. Must be a numeric HTTP status code (e.g. 200, 404, 500).'));
    }
    query = query.eq('response_status', statusCode);
  }
  if (key_id) query = query.eq('api_key_id', key_id as string);

  const { data, error, count } = await query;
  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse({ logs: data, total: count, page: pageNum, limit: limitNum }));
};
