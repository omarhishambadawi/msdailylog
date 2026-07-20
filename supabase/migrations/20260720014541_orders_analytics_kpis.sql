-- [ANALYTICS] Focused, relational order-analytics RPCs — vertical slice 1.
--
-- Target architecture: move Dashboard aggregation out of the browser into
-- focused, single-responsibility SQL functions that return relational rows.
-- This first slice adds the shared filter base + the headline KPI function.
--
-- orders_in_scope() is the SINGLE definition of the analytics filter (date
-- window + team/agent/mine). Every future orders_* RPC selects from it so the
-- scoping predicate is never duplicated. SECURITY INVOKER: RLS on public.orders
-- still applies, and _team/_agent/_mine narrow further.

CREATE OR REPLACE FUNCTION public.orders_in_scope(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS SETOF public.orders
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT o.*
  FROM public.orders o
  WHERE o.order_date >= _from
    AND o.order_date <= _to
    AND (_team = 'all' OR o.team::text = _team)
    AND (_agent IS NULL OR o.agent_id = _agent)
    AND (NOT _mine OR o.agent_id = auth.uid())
$$;

GRANT EXECUTE ON FUNCTION public.orders_in_scope(date, date, text, uuid, boolean) TO authenticated;

-- Headline KPIs, one row per order-type bucket (cash / wasfaty / total).
CREATE OR REPLACE FUNCTION public.orders_kpis(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  bucket           text,
  total_sales      numeric,
  completed_sales  numeric,
  order_count      bigint,
  completed_count  bigint,
  pending_count    bigint,
  cancelled_count  bigint,
  completion_rate  numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT invoice_value, order_type, status
    FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
  ),
  agg AS (
    SELECT 'cash'::text AS bucket,
      COALESCE(SUM(invoice_value), 0)                                     AS total_sales,
      COALESCE(SUM(invoice_value) FILTER (WHERE status = 'Completed'), 0) AS completed_sales,
      COUNT(*)                                                            AS order_count,
      COUNT(*) FILTER (WHERE status = 'Completed')                        AS completed_count,
      COUNT(*) FILTER (WHERE status = 'Pending')                          AS pending_count,
      COUNT(*) FILTER (WHERE status = 'Cancelled')                        AS cancelled_count
    FROM s WHERE order_type = 'Cash'
    UNION ALL
    SELECT 'wasfaty',
      COALESCE(SUM(invoice_value), 0),
      COALESCE(SUM(invoice_value) FILTER (WHERE status = 'Completed'), 0),
      COUNT(*), COUNT(*) FILTER (WHERE status = 'Completed'),
      COUNT(*) FILTER (WHERE status = 'Pending'),
      COUNT(*) FILTER (WHERE status = 'Cancelled')
    FROM s WHERE order_type = 'Wasfaty'
    UNION ALL
    SELECT 'total',
      COALESCE(SUM(invoice_value), 0),
      COALESCE(SUM(invoice_value) FILTER (WHERE status = 'Completed'), 0),
      COUNT(*), COUNT(*) FILTER (WHERE status = 'Completed'),
      COUNT(*) FILTER (WHERE status = 'Pending'),
      COUNT(*) FILTER (WHERE status = 'Cancelled')
    FROM s
  )
  SELECT bucket, total_sales, completed_sales, order_count, completed_count,
         pending_count, cancelled_count,
         CASE WHEN order_count > 0
              THEN (completed_count::numeric / order_count) * 100
              ELSE 0 END AS completion_rate
  FROM agg;
$$;

GRANT EXECUTE ON FUNCTION public.orders_kpis(date, date, text, uuid, boolean) TO authenticated;
