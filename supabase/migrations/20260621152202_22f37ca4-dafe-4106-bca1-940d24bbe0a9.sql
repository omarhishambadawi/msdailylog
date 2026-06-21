DROP POLICY IF EXISTS "Agents view own orders or admin" ON public.orders;
CREATE POLICY "Authenticated users view all orders" ON public.orders FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
UPDATE public.orders SET status = 'Completed' WHERE status = 'Closed';