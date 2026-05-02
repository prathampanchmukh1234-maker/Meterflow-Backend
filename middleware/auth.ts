import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { billingQueue } from '../config/bullmq';
import { ensureUserProfile } from '../utils/profile';

export async function verifyAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed authorization header' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Unauthorized: Invalid session' });
  }

  (req as any).user = user;
  next();
}

export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    let { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    // Auto-heal: if the signup trigger failed, create the profile now
    if (!profile) {
      profile = await ensureUserProfile(user);

      // Schedule monthly billing for this new user
      try {
        const existingJobs = await billingQueue.getRepeatableJobs();
        const jobId = `billing-${user.id}`;
        if (!existingJobs.find((j: any) => j.id === jobId)) {
          await billingQueue.add(
            'calculate-billing',
            { userId: user.id },
            { repeat: { pattern: '0 0 1 * *' }, jobId }
          );
        }
      } catch (schedErr) {
        console.error('Failed to schedule billing for new user:', schedErr);
        // Non-fatal: billing can be caught up on next server restart
      }
    }

    if (!profile || !roles.includes(profile.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    (req as any).userRole = profile.role;
    next();
  };
}
