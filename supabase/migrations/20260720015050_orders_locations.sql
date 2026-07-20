-- [ANALYTICS] orders_locations — per-branch and per-city sales (slice 6).
-- Same metric as the Dashboard byBranch / byCity groupAgg. One RPC returns
-- both, discriminated by location_type ('branch'|'city'). City is resolved by
-- joining branches (matching the client's cityMap). Columns cover every
-- consumer: bar charts (completed_sales) and the heat map (order_count,
-- total_sales, completed_count).

CREATE OR REPLACE FUNCTION public.orders_locations(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  location_type   text,
  location        text,
  order_count     bigint,
  completed_sales numeric,
  completed_count bigint,
  total_sales     numeric,
  completion_rate numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT branch_no, invoice_value, status
    FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
  )
  SELECT 'branch'::text AS location_type,
         COALESCE(s.branch_no, '—') AS location,
         COUNT(*) AS order_count,
         COALESCE(SUM(s.invoice_value) FILTER (WHERE s.status = 'Completed'), 0) AS completed_sales,
         COUNT(*) FILTER (WHERE s.status = 'Completed') AS completed_count,
         COALESCE(SUM(s.invoice_value), 0) AS total_sales,
         CASE WHEN COUNT(*) > 0 THEN (COUNT(*) FILTER (WHERE s.status = 'Completed')::numeric / COUNT(*)) * 100 ELSE 0 END AS completion_rate
  FROM s
  GROUP BY s.branch_no
  UNION ALL
  SELECT 'city'::text,
         COALESCE(b.city, '—') AS location,
         COUNT(*),
         COALESCE(SUM(s.invoice_value) FILTER (WHERE s.status = 'Completed'), 0),
         COUNT(*) FILTER (WHERE s.status = 'Completed'),
         COALESCE(SUM(s.invoice_value), 0),
         CASE WHEN COUNT(*) > 0 THEN (COUNT(*) FILTER (WHERE s.status = 'Completed')::numeric / COUNT(*)) * 100 ELSE 0 END
  FROM s
  LEFT JOIN public.branches b ON b.branch_no = s.branch_no
  GROUP BY b.city
$$;

GRANT EXECUTE ON FUNCTION public.orders_locations(date, date, text, uuid, boolean) TO authenticated;
