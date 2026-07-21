-- [SEC] Revoke anonymous EXECUTE on the authorization RPCs.
--
-- 20260702022213 and 20260702022413 granted EXECUTE on has_role,
-- has_permission, is_active and is_administrator to `anon`. All four are
-- SECURITY DEFINER (they read user_roles / profiles with RLS bypassed) and all
-- four take an arbitrary _user_id parameter rather than deriving it from
-- auth.uid().
--
-- The publishable/anon key is inlined into the client bundle and is therefore
-- public. Combined with these grants, anyone could query, with no login at all:
--
--   POST /rest/v1/rpc/is_administrator {"_user_id": "<uuid>"}
--   POST /rest/v1/rpc/has_permission   {"_user_id": "<uuid>", "_permission": "manage_users"}
--   POST /rest/v1/rpc/has_role         {"_user_id": "<uuid>", "_role": "owner"}
--   POST /rest/v1/rpc/is_active        {"_user_id": "<uuid>"}
--
-- i.e. an unauthenticated oracle for "is this account an administrator", "what
-- permissions does it hold" and "is it active" -- reconnaissance for targeting
-- privileged accounts. There is no anonymous feature that needs this.
--
-- Safe to revoke: every surviving RLS policy is qualified `TO authenticated`
-- (or service_role), so none of these functions is ever evaluated on behalf of
-- anon. The two historical policies that omitted a TO clause -- and so defaulted
-- to PUBLIC -- were both dropped:
--   "Authenticated users view all complaints" (dropped 20260701223527)
--   "avatars_public_read"                     (dropped 20260720011010)
-- handle_new_user() runs as SECURITY DEFINER on the auth.users trigger and does
-- not depend on the caller holding EXECUTE.
--
-- authenticated and service_role keep their grants: RLS policies invoke these
-- functions for signed-in users, and the app calls has_permission /
-- is_administrator directly from server functions.

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_active(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_administrator(uuid) FROM anon;
