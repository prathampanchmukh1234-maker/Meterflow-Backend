import { Request, Response } from 'express';
import { formatError, formatResponse } from '../utils/helpers';
import { ensureUserProfile } from '../utils/profile';

export const getProfile = async (req: Request, res: Response) => {
  const authUser = (req as any).user;

  try {
    const profile = await ensureUserProfile(authUser);
    res.json(formatResponse(profile));
  } catch (error: any) {
    res.status(500).json(formatError(error.message));
  }
};
