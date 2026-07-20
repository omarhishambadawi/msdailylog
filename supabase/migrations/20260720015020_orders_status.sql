-- [ANALYTICS] orders_status — order count per status (slice 3).
-- Same metric as the Dashboard's client-side byStatus count, grouped in SQL.

CREATE OR REPLACE FUNCTION public.orders_status(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  status      text,
  order_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT status, COUNT(*) AS order_count
  FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
  GROUP BY status
  ORDER BY order_count DESC
$$;

GRANT EXECUTE ON FUNCTION public.orders_status(date, date, text, uuid, boolean) TO authenticated;
