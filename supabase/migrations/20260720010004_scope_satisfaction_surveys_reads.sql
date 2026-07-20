-- [SEC] Scope satisfaction_surveys reads to authorized viewers.
--
-- The "Authenticated can read surveys" SELECT policy used USING (true), so any
-- authenticated user could read every agent's individual ratings and free-text
-- comments -- peer-to-peer performance-data exposure. Restrict reads to
-- administrators/owners, supervisors/auditors (view_all_agents), and each
-- agent's own survey rows.
--
-- Unchanged: INSERT stays admin-only ("Admins can insert surveys"); rows remain
-- immutable (no UPDATE/DELETE policy exists).

DROP POLICY IF EXISTS "Authenticated can read surveys" ON public.satisfaction_surveys;

CREATE POLICY "Surveys visible by scope" ON public.satisfaction_surveys
  FOR SELECT
  TO authenticated
  USING (
    public.is_administrator(auth.uid())
    OR public.has_permission(auth.uid(), 'view_all_agents')
    OR agent_id = auth.uid()
  );
