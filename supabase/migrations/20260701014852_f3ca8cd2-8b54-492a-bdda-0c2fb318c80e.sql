
REVOKE ALL ON FUNCTION public.notify_users(uuid[], text, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_on_order_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_on_complaint_change() FROM PUBLIC, anon, authenticated;
