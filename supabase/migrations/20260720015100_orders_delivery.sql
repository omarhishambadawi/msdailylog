-- [ANALYTICS] orders_delivery — per-delivery-method totals (slice 7).
-- Same metric as the Dashboard byDelivery groupAgg: order count, completed
-- sales and completion rate per delivery_type, grouped in SQL.

CREATE OR REPLACE FUNCTION public.orders_delivery(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  delivery_type   text,
  order_count     bigint,
  completed_sales numeric,
  completion_rate numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(delivery_type, '—') AS delivery_type,
         COUNT(*) AS order_count,
         COALESCE(SUM(invoice_value) FILTER (WHERE status = 'Completed'), 0) AS completed_sales,
         CASE WHEN COUNT(*) > 0
              THEN (COUNT(*) FILTER (WHERE status = 'Completed')::numeric / COUNT(*)) * 100
              ELSE 0 END AS completion_rate
  FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
  GROUP BY delivery_type
  ORDER BY order_count DESC
$$;

GRANT EXECUTE ON FUNCTION public.orders_delivery(date, date, text, uuid, boolean) TO authenticated;
