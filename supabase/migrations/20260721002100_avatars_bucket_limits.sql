-- [SEC] Enforce avatar upload limits at the storage layer.
--
-- _app.profile.tsx checks `file.type.startsWith("image/")` and a 4 MB ceiling
-- before uploading, but both are client-side only: the browser also supplies
-- `contentType` on the upload call, so a crafted request could store any
-- payload of any size under the caller's own avatars/<uid>/ prefix. The
-- ownership policies (20260709174246 / 20260720011010) constrain WHERE a user
-- may write, never WHAT.
--
-- Storage enforces bucket-level allowed_mime_types and file_size_limit
-- server-side, on the same request path the client uses, so this closes the gap
-- without touching the upload UI. Limits match what the client already claims
-- to enforce, so legitimate uploads are unaffected.
--
-- The bucket stays private; reads remain owner-scoped plus signed URLs.

UPDATE storage.buckets
SET
  file_size_limit = 4194304,  -- 4 MB, matching the client-side check
  allowed_mime_types = ARRAY[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif'
  ]
WHERE id = 'avatars';
