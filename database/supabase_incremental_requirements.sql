-- Incremental migration for MeterFlow requirement completion.
-- Safe to run after the original supabase_migration.sql.

ALTER TABLE public.users
DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'api_owner', 'consumer'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'billing_user_period_unique'
  ) THEN
    ALTER TABLE public.billing
    ADD CONSTRAINT billing_user_period_unique UNIQUE (user_id, period_start);
  END IF;
END $$;

ALTER TABLE public.plans
ADD COLUMN IF NOT EXISTS monthly_price_inr numeric DEFAULT 0;

UPDATE public.plans SET monthly_price_inr = 0 WHERE name = 'Free' AND monthly_price_inr IS NULL;
UPDATE public.plans SET monthly_price_inr = 999 WHERE name = 'Pro' AND (monthly_price_inr IS NULL OR monthly_price_inr = 0);
UPDATE public.plans SET monthly_price_inr = 4999 WHERE name = 'Enterprise' AND (monthly_price_inr IS NULL OR monthly_price_inr = 0);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'role', ''), 'api_owner')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
