-- SQL Migration for MeterFlow
-- To be run in Supabase SQL Editor

-- 1. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Base Tables
CREATE TABLE public.plans (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    name text NOT NULL,
    free_quota integer DEFAULT 1000,
    price_per_100_requests numeric DEFAULT 0.5,
    rate_limit_per_minute integer DEFAULT 60,
    monthly_price_inr numeric DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

-- Seed Plans
INSERT INTO public.plans (name, free_quota, price_per_100_requests, rate_limit_per_minute, monthly_price_inr)
VALUES 
('Free', 1000, 0.5, 60, 0),
('Pro', 10000, 0.4, 500, 999),
('Enterprise', 100000, 0.2, 5000, 4999);

CREATE TABLE public.users (
    id uuid REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
    email text UNIQUE NOT NULL,
    name text,
    role text DEFAULT 'api_owner' CHECK (role IN ('admin', 'api_owner', 'consumer')),
    plan_id uuid REFERENCES public.plans(id) DEFAULT (SELECT id FROM public.plans WHERE name = 'Free' LIMIT 1),
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.apis (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id uuid REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    name text NOT NULL,
    description text,
    base_url text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.api_keys (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    api_id uuid REFERENCES public.apis(id) ON DELETE CASCADE NOT NULL,
    user_id uuid REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL, -- last 6 chars for visibility
    name text,
    status text DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'rotated')),
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone
);

CREATE TABLE public.usage_logs (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
    api_id uuid REFERENCES public.apis(id) ON DELETE CASCADE NOT NULL,
    user_id uuid REFERENCES public.users(id) NOT NULL, -- The owner of the API
    endpoint text NOT NULL,
    method text NOT NULL,
    response_status integer NOT NULL,
    latency_ms integer NOT NULL,
    ip_address text,
    user_agent text,
    timestamp timestamp with time zone DEFAULT now()
);

CREATE TABLE public.billing (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id uuid REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    total_requests integer DEFAULT 0,
    free_quota_used integer DEFAULT 0,
    billable_requests integer DEFAULT 0,
    amount_inr numeric DEFAULT 0,
    status text DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
    invoice_id text,
    invoice_url text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.billing
ADD CONSTRAINT billing_user_period_unique UNIQUE (user_id, period_start);

CREATE TABLE public.webhooks (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id uuid REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    endpoint_url text NOT NULL,
    events text[] DEFAULT '{}',
    secret text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.audit_logs (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    action text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);

-- 3. Indexes
CREATE INDEX idx_usage_logs_key_time ON public.usage_logs (api_key_id, timestamp);
CREATE INDEX idx_usage_logs_api_time ON public.usage_logs (api_id, timestamp);
CREATE INDEX idx_usage_logs_user_time ON public.usage_logs (user_id, timestamp);
CREATE INDEX idx_api_keys_hash ON public.api_keys (key_hash);

-- 4. RLS Policies
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Simple Ownership Policies
CREATE POLICY "Users can view their own profile" ON public.users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update their own profile" ON public.users FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can manage their own APIs" ON public.apis FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own API keys" ON public.api_keys FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own usage logs" ON public.usage_logs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own billing" ON public.billing FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own webhooks" ON public.webhooks FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can view their own audit logs" ON public.audit_logs FOR SELECT USING (auth.uid() = user_id);

-- 5. Helper Functions
-- Function to update the last_used_at of an API key
CREATE OR REPLACE FUNCTION public.update_key_usage(key_id uuid)
RETURNS void AS $$
BEGIN
    UPDATE public.api_keys SET last_used_at = now() WHERE id = key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create user profile on signup
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

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
