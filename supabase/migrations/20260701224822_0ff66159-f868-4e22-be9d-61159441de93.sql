DROP TRIGGER IF EXISTS trg_complaint_activity ON public.complaints;
DROP TRIGGER IF EXISTS trg_complaint_notifications ON public.complaints;
DROP TRIGGER IF EXISTS trg_complaints_updated_at ON public.complaints;
DROP TRIGGER IF EXISTS trg_order_activity ON public.orders;
DROP TRIGGER IF EXISTS trg_order_notifications ON public.orders;
DROP TRIGGER IF EXISTS trg_orders_updated_at ON public.orders;
DROP TRIGGER IF EXISTS trg_prevent_order_reassignment ON public.orders;
DROP TRIGGER IF EXISTS trg_prevent_profile_escalation ON public.profiles;
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;

CREATE OR REPLACE VIEW public.profile_directory AS
SELECT id, full_name
FROM public.profiles
WHERE active = true;

GRANT SELECT ON public.profile_directory TO authenticated;
GRANT ALL ON public.profile_directory TO service_role;

DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users view own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Signed-in users view role labels" ON public.user_roles;

CREATE POLICY "Users view own profile or managed profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  id = auth.uid()
  OR public.has_permission(auth.uid(), 'manage_users')
  OR public.has_permission(auth.uid(), 'view_all_agents')
);

CREATE POLICY "Users view permitted role labels"
ON public.user_roles
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.has_permission(auth.uid(), 'manage_users')
  OR public.has_permission(auth.uid(), 'view_all_agents')
);