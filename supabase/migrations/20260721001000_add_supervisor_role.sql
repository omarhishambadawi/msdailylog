-- Add the `supervisor` role to the app_role enum.
--
-- Kept in its own migration because Postgres will not allow a newly added enum
-- value to be referenced in the same transaction that adds it. The permission
-- rules for supervisor land in the next migration
-- (20260721001100_supervisor_permissions.sql). This mirrors how 'auditor',
-- 'owner' and 'call_center' were introduced.

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'supervisor';
