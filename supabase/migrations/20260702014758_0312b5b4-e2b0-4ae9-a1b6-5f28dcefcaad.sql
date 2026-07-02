ALTER TABLE public.yeastar_token_cache
  ADD COLUMN auth_lock_holder     text,
  ADD COLUMN auth_lock_expires_at timestamptz;

-- Ensure the singleton row always exists so upsert-less UPDATEs can operate.
INSERT INTO public.yeastar_token_cache (id, access_token, expires_at, cred_fingerprint)
VALUES ('singleton', '', now() - interval '1 hour', '')
ON CONFLICT (id) DO NOTHING;

-- Atomically try to claim the auth lease. Returns the token row IF the caller
-- now owns the lease (either it was free, or the previous holder's lease
-- expired). Returns no row if another worker currently holds a fresh lease.
-- Called by supabaseAdmin (service_role) only.
CREATE OR REPLACE FUNCTION public.yeastar_try_claim_auth_lease(
  _holder     text,
  _lease_sec  integer DEFAULT 15
)
RETURNS TABLE (
  access_token          text,
  refresh_token         text,
  expires_at            timestamptz,
  refresh_expires_at    timestamptz,
  cred_fingerprint      text,
  auth_blocked_until    timestamptz,
  lease_acquired        boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.yeastar_token_cache t
     SET auth_lock_holder     = _holder,
         auth_lock_expires_at = now() + make_interval(secs => _lease_sec)
   WHERE t.id = 'singleton'
     AND (t.auth_lock_holder IS NULL
          OR t.auth_lock_expires_at IS NULL
          OR t.auth_lock_expires_at < now()
          OR t.auth_lock_holder = _holder)
  RETURNING
    t.access_token,
    t.refresh_token,
    t.expires_at,
    t.refresh_expires_at,
    t.cred_fingerprint,
    t.auth_blocked_until,
    true AS lease_acquired;
END;
$$;

REVOKE ALL ON FUNCTION public.yeastar_try_claim_auth_lease(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.yeastar_try_claim_auth_lease(text, integer) TO service_role;

-- Release the lease (only if we still hold it).
CREATE OR REPLACE FUNCTION public.yeastar_release_auth_lease(_holder text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.yeastar_token_cache
     SET auth_lock_holder = NULL,
         auth_lock_expires_at = NULL
   WHERE id = 'singleton' AND auth_lock_holder = _holder;
$$;

REVOKE ALL ON FUNCTION public.yeastar_release_auth_lease(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.yeastar_release_auth_lease(text) TO service_role;