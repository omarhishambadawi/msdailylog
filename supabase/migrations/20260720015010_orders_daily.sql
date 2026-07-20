-- [ANALYTICS] orders_daily — per-day sales time series (slice 2).
-- Same metric as the Dashboard's client-side byDay reduction (total sales and
-- completed sales per order_date), but grouped in SQL over the shared scope
-- base and keyed on the FULL date, so the daily-trend chart orders correctly
-- across a year boundary. The client keeps formatting the label (MM-DD).

CREATE OR REPLACE FUNCTION public.orders_daily(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  day             date,
  total_sales     numeric,
  completed_sales numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT order_date AS day,
         COALESCE(SUM(invoice_value), 0)                                     AS total_sales,
         COALESCE(SUM(invoice_value) FILTER (WHERE status = 'Completed'), 0) AS completed_sales
  FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
  GROUP BY order_date
  ORDER BY order_date
$$;

GRANT EXECUTE ON FUNCTION public.orders_daily(date, date, text, uuid, boolean) TO authenticated;
