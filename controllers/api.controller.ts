import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { formatResponse, formatError, auditLog } from '../utils/helpers';

export const getApis = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { data, error } = await supabase
    .from('apis')
    .select('*')
    .eq('user_id', user.id);

  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(data));
};

export const createApi = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { name, description, base_url } = req.body;

  const { data, error } = await supabase
    .from('apis')
    .insert([{ name, description, base_url, user_id: user.id }])
    .select()
    .single();

  if (error) return res.status(500).json(formatError(error.message));
  res.status(201).json(formatResponse(data, 'API created successfully'));
};

export const updateApi = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;
  const { name, description, base_url, is_active } = req.body;

  const { data, error } = await supabase
    .from('apis')
    .update({ name, description, base_url, is_active })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) return res.status(500).json(formatError(error.message));
  res.json(formatResponse(data, 'API updated successfully'));
};

export const deleteApi = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { id } = req.params;

  const { error } = await supabase
    .from('apis')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) return res.status(500).json(formatError(error.message));
  
  auditLog(supabase, user.id, 'api.deleted', { api_id: id });
  res.json(formatResponse(null, 'API deleted successfully'));
};
