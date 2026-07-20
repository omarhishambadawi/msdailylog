-- [ANALYTICS] orders_teams — per-team totals (slice 4).
-- Same metric as the Dashboard byTeam groupAgg: order count, completed sales,
-- and completion rate per team, grouped in SQL.

CREATE OR REPLACE FUNCTION public.orders_teams(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  team            text,
  order_count     bigint,
  completed_sales numeric,
  completion_rate numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT team::text AS team,
         COUNT(*) AS order_count,
         COALESCE(SUM(invoice_value) FILTER (WHERE status = 'Completed'), 0) AS completed_sales,
         CASE WHEN COUNT(*) > 0
              THEN (COUNT(*) FILTER (WHERE status = 'Completed')::numeric / COUNT(*)) * 100
              ELSE 0 END AS completion_rate
  FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
  GROUP BY team
  ORDER BY completed_sales DESC
$$;

GRANT EXECUTE ON FUNCTION public.orders_teams(date, date, text, uuid, boolean) TO authenticated;
