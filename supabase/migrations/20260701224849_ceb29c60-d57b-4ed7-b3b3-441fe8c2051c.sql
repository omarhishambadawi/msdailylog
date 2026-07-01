DROP VIEW IF EXISTS public.profile_directory;

CREATE VIEW public.profile_directory
WITH (security_invoker = true) AS
SELECT id, full_name
FROM public.profiles
WHERE active = true;

GRANT SELECT ON public.profile_directory TO authenticated;
GRANT ALL ON public.profile_directory TO service_role;