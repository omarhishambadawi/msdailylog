-- Owner role protection, enforced in the database.
--
-- `owner` already existed (20260702022357) and already short-circuits
-- has_permission() and is_administrator(). What was missing is protection: any
-- admin could demote, deactivate or delete an owner, and nothing stopped the
-- last owner from being removed entirely -- which would leave the platform with
-- no account able to manage roles.
--
-- These are the invariants, enforced at the lowest layer so they hold no matter
-- which path performs the write (server function via service_role, PostgREST,
-- SQL console, or a future feature):
--
--   1. An owner's role row cannot be changed or deleted while another owner
--      does not exist -- i.e. the system always retains at least one owner.
--   2. An owner cannot be deactivated (profiles.active = false).
--   3. An owner's profile row cannot be deleted.
--
-- Actor-level rules ("only an owner may modify another owner") live in the
-- server functions, because every privileged write runs as service_role where
-- auth.uid() is NULL and the DB cannot identify the caller. The triggers below
-- are the invariant backstop; admin.functions.ts is the gate.

-- Convenience predicate, mirroring is_administrator().
CREATE OR REPLACE FUNCTION public.is_owner(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'owner'::public.app_role
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_owner(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_owner(uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- 1 + 2. Never allow the last owner to lose the role.
-- ---------------------------------------------------------------------------
-- adminSetRole performs DELETE-then-INSERT on user_roles, so both paths must be
-- covered. The check counts owners EXCLUDING the row being modified: if that
-- reaches zero, the operation would remove the final owner and is refused.

CREATE OR REPLACE FUNCTION public.protect_last_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _remaining int;
BEGIN
  -- Only relevant when an owner row is being removed or demoted.
  IF OLD.role <> 'owner'::public.app_role THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.role = 'owner'::public.app_role THEN
    RETURN NEW; -- still an owner, nothing to protect
  END IF;

  SELECT count(*) INTO _remaining
  FROM public.user_roles
  WHERE role = 'owner'::public.app_role
    AND user_id <> OLD.user_id;

  IF _remaining = 0 THEN
    RAISE EXCEPTION 'Cannot remove the last Owner: at least one Owner must always exist';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_last_owner ON public.user_roles;
CREATE TRIGGER trg_protect_last_owner
  BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.protect_last_owner();

-- ---------------------------------------------------------------------------
-- 3. An owner can never be deactivated, and their profile cannot be deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_owner_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.is_owner(OLD.id) THEN
      RAISE EXCEPTION 'Owner accounts cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: block deactivation of an owner.
  IF OLD.active IS DISTINCT FROM NEW.active
     AND NEW.active = false
     AND public.is_owner(NEW.id) THEN
    RAISE EXCEPTION 'Owner accounts cannot be deactivated';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_owner_profile ON public.profiles;
CREATE TRIGGER trg_protect_owner_profile
  BEFORE UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_owner_profile();

-- ---------------------------------------------------------------------------
-- Owner may bypass the self-escalation guard.
-- ---------------------------------------------------------------------------
-- prevent_profile_escalation checked has_role(...,'admin') only, so an owner
-- acting through an authenticated session was blocked from edits an admin could
-- make. Owner and admin are equivalent everywhere else (is_administrator), so
-- align it. yeastar_ext stays guarded (added 20260721000100).
CREATE OR REPLACE FUNCTION public.prevent_profile_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_administrator(auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.agent_code IS DISTINCT FROM OLD.agent_code THEN
    RAISE EXCEPTION 'Not allowed to change agent_code';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    RAISE EXCEPTION 'Not allowed to change active flag';
  END IF;
  IF NEW.permissions IS DISTINCT FROM OLD.permissions THEN
    RAISE EXCEPTION 'Not allowed to change permissions';
  END IF;
  IF NEW.yeastar_ext IS DISTINCT FROM OLD.yeastar_ext THEN
    RAISE EXCEPTION 'Not allowed to change yeastar_ext';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Not allowed to change id';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Pin the designated Owner account.
-- ---------------------------------------------------------------------------
-- Idempotent and non-fatal: if the account has not signed up yet the migration
-- still succeeds, and the assignment can be re-run later. Runs before the
-- triggers could conflict because it only ever promotes TO owner.
DO $$
DECLARE
  _uid uuid;
BEGIN
  SELECT id INTO _uid FROM auth.users
  WHERE lower(email) = lower('omarhishambadawi@gmail.com')
  LIMIT 1;

  IF _uid IS NULL THEN
    RAISE NOTICE 'Owner account omarhishambadawi@gmail.com not found; skipping owner assignment.';
    RETURN;
  END IF;

  INSERT INTO public.profiles (id, full_name, active)
  VALUES (_uid, 'Owner', true)
  ON CONFLICT (id) DO UPDATE SET active = true;

  DELETE FROM public.user_roles WHERE user_id = _uid AND role <> 'owner'::public.app_role;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (_uid, 'owner'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;
END $$;
