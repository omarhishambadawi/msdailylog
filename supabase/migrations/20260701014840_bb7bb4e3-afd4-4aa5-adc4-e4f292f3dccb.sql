
-- 1) Add auditor role
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'auditor';

-- 2) Notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  entity_type text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON public.notifications(user_id, read_at, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own notifications select" ON public.notifications;
CREATE POLICY "own notifications select" ON public.notifications
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "own notifications update" ON public.notifications;
CREATE POLICY "own notifications update" ON public.notifications
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "own notifications delete" ON public.notifications;
CREATE POLICY "own notifications delete" ON public.notifications
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
-- No INSERT policy for authenticated: notifications are inserted by SECURITY DEFINER triggers only

-- 3) Notification triggers
CREATE OR REPLACE FUNCTION public.notify_users(_user_ids uuid[], _kind text, _title text, _body text, _link text, _entity_type text, _entity_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications(user_id, kind, title, body, link, entity_type, entity_id)
  SELECT DISTINCT uid, _kind, _title, _body, _link, _entity_type, _entity_id
  FROM unnest(_user_ids) AS uid
  WHERE uid IS NOT NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.notify_on_order_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  admins uuid[];
  targets uuid[];
  title text; body text; kind text;
BEGIN
  SELECT COALESCE(array_agg(user_id), '{}') INTO admins FROM public.user_roles WHERE role = 'admin';

  IF TG_OP = 'INSERT' THEN
    kind := 'order_created';
    title := 'New order ' || COALESCE(NEW.display_no, '');
    body := 'A new order was created';
    targets := admins || ARRAY[NEW.agent_id];
    PERFORM public.notify_users(targets, kind, title, body, '/orders/' || NEW.id::text, 'order', NEW.id);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      kind := 'order_status';
      title := 'Order ' || COALESCE(NEW.display_no, '') || ' → ' || NEW.status;
      body := 'Status changed from ' || OLD.status || ' to ' || NEW.status;
    ELSE
      kind := 'order_updated';
      title := 'Order ' || COALESCE(NEW.display_no, '') || ' updated';
      body := 'Order details were edited';
    END IF;
    targets := admins || ARRAY[NEW.agent_id];
    PERFORM public.notify_users(targets, kind, title, body, '/orders/' || NEW.id::text, 'order', NEW.id);
    RETURN NEW;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_order ON public.orders;
CREATE TRIGGER trg_notify_order AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_order_change();

CREATE OR REPLACE FUNCTION public.notify_on_complaint_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  admins uuid[];
  targets uuid[];
  title text; body text; kind text;
BEGIN
  SELECT COALESCE(array_agg(user_id), '{}') INTO admins FROM public.user_roles WHERE role = 'admin';

  IF TG_OP = 'INSERT' THEN
    kind := 'complaint_created';
    title := 'New complaint ' || COALESCE(NEW.display_no, '');
    body := 'A new complaint was logged';
    targets := admins || ARRAY[NEW.agent_id];
    PERFORM public.notify_users(targets, kind, title, body, '/complaints/' || NEW.id::text, 'complaint', NEW.id);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      kind := 'complaint_status';
      title := 'Complaint ' || COALESCE(NEW.display_no, '') || ' → ' || NEW.status;
      body := 'Status changed from ' || OLD.status || ' to ' || NEW.status;
    ELSE
      kind := 'complaint_updated';
      title := 'Complaint ' || COALESCE(NEW.display_no, '') || ' updated';
      body := 'Complaint details were edited';
    END IF;
    targets := admins || ARRAY[NEW.agent_id];
    PERFORM public.notify_users(targets, kind, title, body, '/complaints/' || NEW.id::text, 'complaint', NEW.id);
    RETURN NEW;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_complaint ON public.complaints;
CREATE TRIGGER trg_notify_complaint AFTER INSERT OR UPDATE ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_complaint_change();

-- 4) Reset demo data
TRUNCATE TABLE public.order_activity RESTART IDENTITY CASCADE;
TRUNCATE TABLE public.notifications RESTART IDENTITY CASCADE;
DELETE FROM public.orders;
DELETE FROM public.complaints;

-- Sequences: next nextval() should return 4363 / 104
SELECT setval('public.order_display_seq', 4362, true);
SELECT setval('public.complaint_display_seq', 103, true);
