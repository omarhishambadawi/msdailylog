-- [ANALYTICS] orders_agents — per-agent sales (slice 5).
-- Same metric as the Dashboard byAgent groupAgg (order count, completed sales,
-- completion rate per agent), grouped by agent_id in SQL and joined to
-- profiles for the display name. Returns all agents ordered by completed
-- sales; the client slices the top N for the chart.

CREATE OR REPLACE FUNCTION public.orders_agents(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  agent_id        uuid,
  agent_name      text,
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
  SELECT o.agent_id,
         COALESCE(p.full_name, 'Unknown') AS agent_name,
         MIN(o.team::text) AS team,
         COUNT(*) AS order_count,
         COALESCE(SUM(o.invoice_value) FILTER (WHERE o.status = 'Completed'), 0) AS completed_sales,
         CASE WHEN COUNT(*) > 0
              THEN (COUNT(*) FILTER (WHERE o.status = 'Completed')::numeric / COUNT(*)) * 100
              ELSE 0 END AS completion_rate
  FROM public.orders_in_scope(_from, _to, _team, _agent, _mine) o
  LEFT JOIN public.profiles p ON p.id = o.agent_id
  GROUP BY o.agent_id, p.full_name
  ORDER BY completed_sales DESC
$$;

GRANT EXECUTE ON FUNCTION public.orders_agents(date, date, text, uuid, boolean) TO authenticated;
