-- Supervisor permission rules.
--
-- Supervisor sits between the administrators (owner/admin) and the agent roles
-- (customer_care / telesales / call_center). It is an operational role: it runs
-- the daily order and complaint workflow across the whole team, but has no
-- access to user administration, role/permission management or system settings.
--
-- CAN:    view all orders, edit any order, reassign orders, manage complaints
--         end-to-end, verify invoices, view team analytics for all agents.
-- CANNOT: manage_users, manage_roles, admin_access (branch/system settings),
--         delete_orders, delete_complaints, view_reports.
--
-- "Reassign Orders" is expressed as edit_all_orders: prevent_order_reassignment
-- permits changing agent_id/team only for callers holding edit_all_orders, so
-- that single permission is what makes reassignment possible.
--
-- _allowed is the ceiling of what may ever be granted to the role (an admin
-- cannot tick a box outside it); _defaults is what a supervisor gets when no
-- explicit per-user permission list is set. Same shape as the other roles.
--
-- Unchanged: owner/admin still short-circuit to true; auditor stays read-only;
-- customer_care, telesales and call_center keep byte-identical rule sets.

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _perms text[];
  _auditor_safe text[] := ARRAY[
    'view_orders','view_complaints','view_dashboard','view_team_analytics',
    'view_all_agents','view_invoice_analytics','view_reports','export_reports',
    'view_call_center','view_branches'
  ];
  _allowed text[];
  _defaults text[];
BEGIN
  IF _user_id IS NULL OR _permission IS NULL THEN RETURN false; END IF;
  SELECT role INTO _role FROM public.user_roles WHERE user_id = _user_id LIMIT 1;
  IF _role IS NULL THEN RETURN false; END IF;
  IF _role IN ('admin'::public.app_role, 'owner'::public.app_role) THEN RETURN true; END IF;
  SELECT permissions INTO _perms FROM public.profiles WHERE id = _user_id;

  IF _role = 'auditor' THEN
    _allowed := _auditor_safe;
    _defaults := _auditor_safe;
  ELSIF _role = 'supervisor' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders','edit_all_orders',
      'view_complaints','create_complaints','edit_complaints','edit_all_complaints',
      'resolve_complaints','resolve_all_complaints',
      'view_dashboard','view_team_analytics','view_all_agents','view_call_center',
      'verify_own_orders','verify_all_orders','view_invoice_analytics',
      'view_branches','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','edit_all_orders',
      'view_complaints','create_complaints','edit_complaints','edit_all_complaints',
      'resolve_complaints','resolve_all_complaints',
      'view_dashboard','view_team_analytics','view_all_agents','view_call_center',
      'verify_own_orders','verify_all_orders','view_branches'
    ];
  ELSIF _role = 'customer_care' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_branches',
      'verify_own_orders','view_invoice_analytics','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_branches','verify_own_orders'
    ];
  ELSIF _role = 'telesales' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_dashboard','view_team_analytics','view_branches',
      'verify_own_orders','view_invoice_analytics','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','view_dashboard','view_branches','verify_own_orders'
    ];
  ELSIF _role = 'call_center' THEN
    _allowed := ARRAY[
      'view_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_call_center','view_branches',
      'view_invoice_analytics','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_call_center','view_branches'
    ];
  ELSE
    RETURN false;
  END IF;

  IF NOT (_permission = ANY(_allowed)) THEN RETURN false; END IF;
  IF COALESCE(array_length(_perms, 1), 0) > 0 THEN RETURN _permission = ANY(_perms); END IF;
  RETURN _permission = ANY(_defaults);
END;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so the anon revoke from
-- 20260721000200 survives. Restated explicitly so a future edit to this
-- function cannot silently hand the authorization oracle back to anon.
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM anon;
