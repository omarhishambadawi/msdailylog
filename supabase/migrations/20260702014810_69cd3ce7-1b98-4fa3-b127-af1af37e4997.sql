REVOKE EXECUTE ON FUNCTION public.yeastar_try_claim_auth_lease(text, integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.yeastar_release_auth_lease(text) FROM anon, authenticated, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.yeastar_try_claim_auth_lease(text, integer) TO service_role;
GRANT  EXECUTE ON FUNCTION public.yeastar_release_auth_lease(text) TO service_role;