-- [ANALYTICS] Complaints analytics RPCs (slice 9b).
-- Complaints have no team column; the Dashboard scopes them by date + agent
-- only (mine for non-privileged). complaints_in_scope is the shared base;
-- complaints_kpis and complaints_locations aggregate over it. SECURITY INVOKER
-- so RLS on public.complaints applies.

CREATE OR REPLACE FUNCTION public.complaints_in_scope(
  _from  date,
  _to    date,
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS SETOF public.complaints
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT c.*
  FROM public.complaints c
  WHERE c.complaint_date >= _from
    AND c.complaint_date <= _to
    AND (_agent IS NULL OR c.agent_id = _agent)
    AND (NOT _mine OR c.agent_id = auth.uid())
$$;

GRANT EXECUTE ON FUNCTION public.complaints_in_scope(date, date, uuid, boolean) TO authenticated;

-- Headline complaint KPIs (one row). "in_progress" = anything not Resolved,
-- matching the client's else-branch.
CREATE OR REPLACE FUNCTION public.complaints_kpis(
  _from  date,
  _to    date,
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  total           bigint,
  in_progress     bigint,
  resolved        bigint,
  resolution_rate numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'Resolved') AS in_progress,
         COUNT(*) FILTER (WHERE status = 'Resolved') AS resolved,
         CASE WHEN COUNT(*) > 0
              THEN (COUNT(*) FILTER (WHERE status = 'Resolved')::numeric / COUNT(*)) * 100
              ELSE 0 END AS resolution_rate
  FROM public.complaints_in_scope(_from, _to, _agent, _mine)
$$;

GRANT EXECUTE ON FUNCTION public.complaints_kpis(date, date, uuid, boolean) TO authenticated;

-- Complaints per branch and per city.
CREATE OR REPLACE FUNCTION public.complaints_locations(
  _from  date,
  _to    date,
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  location_type text,
  location      text,
  total         bigint,
  resolved      bigint,
  open          bigint,
  rate          numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT branch_no, status
    FROM public.complaints_in_scope(_from, _to, _agent, _mine)
  )
  SELECT 'branch'::text AS location_type,
         COALESCE(s.branch_no, '—') AS location,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE s.status = 'Resolved') AS resolved,
         COUNT(*) FILTER (WHERE s.status IS DISTINCT FROM 'Resolved') AS open,
         CASE WHEN COUNT(*) > 0 THEN (COUNT(*) FILTER (WHERE s.status = 'Resolved')::numeric / COUNT(*)) * 100 ELSE 0 END AS rate
  FROM s
  GROUP BY s.branch_no
  UNION ALL
  SELECT 'city'::text,
         COALESCE(b.city, '—'),
         COUNT(*),
         COUNT(*) FILTER (WHERE s.status = 'Resolved'),
         COUNT(*) FILTER (WHERE s.status IS DISTINCT FROM 'Resolved'),
         CASE WHEN COUNT(*) > 0 THEN (COUNT(*) FILTER (WHERE s.status = 'Resolved')::numeric / COUNT(*)) * 100 ELSE 0 END
  FROM s
  LEFT JOIN public.branches b ON b.branch_no = s.branch_no
  GROUP BY b.city
$$;

GRANT EXECUTE ON FUNCTION public.complaints_locations(date, date, uuid, boolean) TO authenticated;
