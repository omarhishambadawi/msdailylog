
-- 1) Restrict orders SELECT to own rows or admin
DROP POLICY IF EXISTS "Agents view all orders" ON public.orders;
CREATE POLICY "Agents view own orders or admin"
ON public.orders FOR SELECT
TO authenticated
USING (auth.uid() = agent_id OR public.has_role(auth.uid(), 'admin'));

-- 2) Prevent agents from reassigning orders (agent_id / team) via trigger
CREATE OR REPLACE FUNCTION public.prevent_order_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
      RAISE EXCEPTION 'Not allowed to change agent_id';
    END IF;
    IF NEW.team IS DISTINCT FROM OLD.team THEN
      RAISE EXCEPTION 'Not allowed to change team';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_prevent_reassignment ON public.orders;
CREATE TRIGGER orders_prevent_reassignment
BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.prevent_order_reassignment();

-- 3) Prevent self-escalation via profile fields (agent_code, active)
CREATE OR REPLACE FUNCTION public.prevent_profile_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    IF NEW.agent_code IS DISTINCT FROM OLD.agent_code THEN
      RAISE EXCEPTION 'Not allowed to change agent_code';
    END IF;
    IF NEW.active IS DISTINCT FROM OLD.active THEN
      RAISE EXCEPTION 'Not allowed to change active flag';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Not allowed to change id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_prevent_escalation ON public.profiles;
CREATE TRIGGER profiles_prevent_escalation
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_escalation();
