-- [ANALYTICS] orders_verification — CC invoice verification per agent (slice 9).
-- Same metric as the Dashboard verifByAgent reduction: per agent, total orders,
-- verified / non-verified counts, verified value, and verification rate. A
-- truthy check on call_center_verified is preserved via IS TRUE / IS NOT TRUE
-- so null/false both count as non-verified (matching the client).

CREATE OR REPLACE FUNCTION public.orders_verification(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  agent_id       uuid,
  agent_name     text,
  total_orders   bigint,
  verified       bigint,
  non_verified   bigint,
  verified_value numeric,
  rate           numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT o.agent_id,
         COALESCE(p.full_name, 'Unknown') AS agent_name,
         COUNT(*) AS total_orders,
         COUNT(*) FILTER (WHERE o.call_center_verified IS TRUE) AS verified,
         COUNT(*) FILTER (WHERE o.call_center_verified IS NOT TRUE) AS non_verified,
         COALESCE(SUM(o.invoice_value) FILTER (WHERE o.call_center_verified IS TRUE), 0) AS verified_value,
         CASE WHEN COUNT(*) > 0
              THEN (COUNT(*) FILTER (WHERE o.call_center_verified IS TRUE)::numeric / COUNT(*)) * 100
              ELSE 0 END AS rate
  FROM public.orders_in_scope(_from, _to, _team, _agent, _mine) o
  LEFT JOIN public.profiles p ON p.id = o.agent_id
  GROUP BY o.agent_id, p.full_name
  ORDER BY verified DESC
$$;

GRANT EXECUTE ON FUNCTION public.orders_verification(date, date, text, uuid, boolean) TO authenticated;
