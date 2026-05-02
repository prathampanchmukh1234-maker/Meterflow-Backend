-- Analytics Helper Functions

-- 1. Daily usage aggregation
CREATE OR REPLACE FUNCTION public.get_daily_usage(user_id_param uuid, start_date timestamp with time zone)
RETURNS TABLE(name text, requests bigint) AS $$
BEGIN
  RETURN QUERY
  SELECT
    TO_CHAR(DATE(timestamp), 'Mon DD') AS name,
    COUNT(id) AS requests
  FROM public.usage_logs
  WHERE user_id = user_id_param AND timestamp >= start_date
  GROUP BY DATE(timestamp)
  ORDER BY DATE(timestamp) ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Top endpoints aggregation
CREATE OR REPLACE FUNCTION public.get_top_endpoints(user_id_param uuid)
RETURNS TABLE(endpoint text, method text, request_count bigint, avg_latency numeric) AS $$
BEGIN
  RETURN QUERY
  SELECT
    usage_logs.endpoint,
    usage_logs.method,
    COUNT(id) AS request_count,
    AVG(latency_ms) AS avg_latency
  FROM public.usage_logs
  WHERE user_id = user_id_param
  GROUP BY usage_logs.endpoint, usage_logs.method
  ORDER BY request_count DESC
  LIMIT 10;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
