-- [SEC] Tighten the avatars read policy to owner-only.
--
-- The avatars bucket is private (storage.buckets.public = false) and avatars are
-- distributed as signed URLs stored in profiles.avatar_url, which carry their
-- own token and do not depend on RLS to render. However the avatars_public_read
-- SELECT policy applied to PUBLIC (including anon) for every object in the
-- bucket, so anyone holding the publishable/anon key (shipped in the client
-- bundle) could directly read -- or mint a signed URL for -- ANY user's avatar,
-- bypassing the signed-URL distribution and defeating the private bucket.
--
-- Scope reads to the owner's own folder, matching the existing
-- insert/update/delete policies. Signed-URL display across the app is
-- unaffected (token-based, RLS-independent); only the upload-time
-- createSignedUrl by the owner needs SELECT, which own-folder access allows.

DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;

CREATE POLICY "avatars_owner_read"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
