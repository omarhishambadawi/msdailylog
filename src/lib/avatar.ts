/**
 * Avatar storage helpers.
 *
 * Avatars live in the private `avatars` bucket under `<uid>/avatar-<ts>.<ext>`.
 * The database stores ONLY that object path in `profiles.avatar_url`; short-lived
 * signed URLs are minted on demand at display time (client-side for the caller's
 * own avatar, server-side with service_role for the admin user list).
 *
 * This module is intentionally import-free so it is safe to consume from both the
 * client bundle (UserAvatar) and the server functions (adminListUsers).
 */

export const AVATAR_BUCKET = "avatars";

/** Short-lived signed-URL TTL, in seconds. Replaces the previous 1-year URLs. */
export const AVATAR_SIGNED_TTL = 60 * 60; // 1 hour

/**
 * True when the stored value is a storage object path (needs signing to
 * display), rather than a ready-to-use URL — a full http(s) URL (legacy
 * long-lived signed URL) or a local `data:` / `blob:` preview.
 */
export function isStoragePath(value?: string | null): boolean {
  return !!value && !/^(https?:|data:|blob:)/i.test(value);
}

/**
 * Resolve the storage object path from a stored avatar value. Accepts both the
 * new path form (returned as-is) and legacy long-lived signed URLs of the shape
 * `…/object/sign/avatars/<path>?token=…` (path extracted). Returns null when no
 * object path can be determined.
 */
export function avatarObjectPath(value?: string | null): string | null {
  if (!value) return null;
  if (isStoragePath(value)) return value;
  const m = value.match(/\/avatars\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
