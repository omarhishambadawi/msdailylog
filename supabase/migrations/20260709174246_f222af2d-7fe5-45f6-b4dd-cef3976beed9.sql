
-- Avatar support + branches viewer permission

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url text;

-- Extend has_permission with view_branches (all non-admin roles get it)
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

-- Allow users to update their own full_name and avatar_url via RLS.
-- prevent_profile_escalation trigger already blocks role/agent_code/permissions/active/id changes.
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
ON public.profiles
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- Storage policies on avatars bucket (bucket created via storage tool).
-- Public read; authenticated users can manage only their own folder (uid/*).
DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;
CREATE POLICY "avatars_public_read"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_owner_insert" ON storage.objects;
CREATE POLICY "avatars_owner_insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "avatars_owner_update" ON storage.objects;
CREATE POLICY "avatars_owner_update"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "avatars_owner_delete" ON storage.objects;
CREATE POLICY "avatars_owner_delete"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
