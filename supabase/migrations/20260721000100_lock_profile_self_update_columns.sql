-- [SEC] Close horizontal privilege escalation via profiles.yeastar_ext.
--
-- `authenticated` held a table-wide UPDATE grant on public.profiles
-- (GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated). Only SELECT was
-- later narrowed to safe columns; UPDATE was never scoped. The
-- "Users can update own profile" policy permits updating one's own row, and the
-- prevent_profile_escalation trigger guards agent_code / active / permissions /
-- id -- but NOT yeastar_ext, which was added later (20260703002603).
--
-- yeastar_ext is the PBX extension used to attribute call records. loadAgents()
-- in yeastar.functions.ts maps a user to their extension, and
-- getCallCenterAnalytics scopes non-privileged callers to their own agent row.
-- So any agent could run:
--
--   update profiles set yeastar_ext = '<victim ext>' where id = auth.uid();
--
-- and then read another agent's call detail records (counterparty numbers,
-- durations, dispositions) through the normal analytics path -- horizontal
-- privilege escalation with no admin involvement.
--
-- Two layers:
--   1. Column-level UPDATE grant: `authenticated` may only write the two
--      columns updateMyProfile() actually patches. This closes the whole class,
--      including columns added in future migrations.
--   2. Add yeastar_ext to the escalation trigger, so the guard still holds if
--      the grant is ever widened again.
--
-- Admin paths are unaffected: admin.functions.ts writes via supabaseAdmin
-- (service_role), which bypasses both column grants and (auth.uid() IS NULL)
-- the trigger's checks.

REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (full_name, avatar_url) ON public.profiles TO authenticated;

-- INSERT/DELETE on profiles are handled by handle_new_user() (SECURITY DEFINER)
-- and admin server functions respectively; no RLS policy grants them to
-- authenticated, but drop the unused table-wide grants so the surface matches
-- the policy set.
REVOKE INSERT, DELETE ON public.profiles FROM authenticated;

CREATE OR REPLACE FUNCTION public.prevent_profile_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin') THEN
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
