-- [ANALYTICS] orders_delivery_matrix — location x delivery-method crosstab (slice 8).
-- Same metric as the Dashboard byDeliveryBranch / byDeliveryCity reductions:
-- completed-order sales per (branch|city) x delivery_type. Emitted as normalized
-- rows; the client pivots into the display grid. COMPLETED orders only, matching
-- the current behaviour.

CREATE OR REPLACE FUNCTION public.orders_delivery_matrix(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  location_type   text,
  location        text,
  delivery_type   text,
  completed_sales numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT branch_no, delivery_type, invoice_value
    FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
    WHERE status = 'Completed'
  )
  SELECT 'branch'::text AS location_type,
         COALESCE(s.branch_no, '—') AS location,
         COALESCE(s.delivery_type, '—') AS delivery_type,
         COALESCE(SUM(s.invoice_value), 0) AS completed_sales
  FROM s
  GROUP BY s.branch_no, s.delivery_type
  UNION ALL
  SELECT 'city'::text,
         COALESCE(b.city, '—') AS location,
         COALESCE(s.delivery_type, '—') AS delivery_type,
         COALESCE(SUM(s.invoice_value), 0)
  FROM s
  LEFT JOIN public.branches b ON b.branch_no = s.branch_no
  GROUP BY b.city, s.delivery_type
$$;

GRANT EXECUTE ON FUNCTION public.orders_delivery_matrix(date, date, text, uuid, boolean) TO authenticated;
