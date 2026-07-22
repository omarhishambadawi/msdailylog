# Supabase configuration diagnostic

## 1. Validation of the uploaded `.env`

All six variable names are correct and match what the codebase reads
(`src/integrations/supabase/client.ts` reads
`VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` with a
`SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` SSR fallback;
`client.server.ts` reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`).

- `SUPABASE_PROJECT_ID` = `gwnxlpophyvgafctrbkx` ✅
- `SUPABASE_URL` = `https://gwnxlpophyvgafctrbkx.supabase.co` ✅ (host matches ref)
- `VITE_*` mirrors of the above ✅
- `SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PUBLISHABLE_KEY` — **INVALID JWT** ❌
- `SUPABASE_SERVICE_ROLE_KEY` — not present in the upload (see §8)

## 2. Internal consistency

URLs, project IDs, and their VITE_ mirrors are consistent and belong to
project `gwnxlpophyvgafctrbkx`. The publishable key claims the same
`ref`, but its payload is malformed (see §3).

## 3. Decoded anon JWT (uploaded key)

Base64-decoding the middle segment yields:

```
{"iss":"supabase","ref":"gwnxlpophyvgafctrbkx","role":"anon",
 "iat":1781843b52,"exp":2097241440}
```

- `iss`: supabase ✅
- `ref`: gwnxlpophyvgafctrbkx ✅ (matches URL)
- `role`: anon ✅
- `exp`: 2097241440 → year 2036 ✅
- `iat`: **`1781843b52`** — contains the letter `b` inside a JSON number.
  This is not valid JSON, so the payload cannot be parsed. Supabase
  Auth/PostgREST reject the key with `Invalid API key` before any
  signature check.

For comparison, the anon key actually provisioned on the project (already
present in the sandbox `.env` and Lovable secrets) decodes cleanly to:

```
{"iss":"supabase","ref":"gwnxlpophyvgafctrbkx","role":"anon",
 "iat":1781962852,"exp":2097538852}
```

Same signature suffix, but `iat` is a valid integer. The uploaded value
is a mangled copy of the real key (one character corrupted during
copy/paste).

## 4. Cause of "Invalid API key"

Not the URL, not the variable names, not the client, not the project
config, not a rotation. It is the **publishable key string itself**: the
JWT payload is not valid JSON, so Supabase rejects every request that
carries it.

## 5. Codebase env wiring

`src/integrations/supabase/client.ts` already reads the correct names
(`import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`,
with server fallbacks). No code change needed.

## 6. Non-env culprits

None. If the correct key is placed in `.env`, no other file is at fault.

## 7. Missing secrets

None required. `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `LOVABLE_API_KEY`, and the three Yeastar
secrets are already configured on the project (verified via
`fetch_secrets`). Only the local `.env` copy of the publishable key is
wrong.

## 8. Service role vs anon

The app needs both:
- **Anon/publishable** — used by the browser client and by RLS-bound
  server functions (`requireSupabaseAuth`). This is the one currently
  broken.
- **Service role** — used only by `src/integrations/supabase/client.server.ts`
  for privileged server work (admin user management, webhooks). It is
  already set as a Lovable Cloud secret on the deployed environment and
  must NEVER be prefixed with `VITE_`. You don't need to add it to your
  local `.env` unless you want to exercise admin server functions
  locally.

## 9. Root cause

The publishable key in the uploaded `.env` has a corrupted payload
(`"iat":1781843b52`). Supabase can't parse the JWT, so every request
returns `Invalid API key`.

## 10. Smallest fix

Replace the two publishable-key lines in your local `.env` with the
valid key already stored in the project (its payload matches
`iat:1781962852`). Everything else in the file is correct and can stay.

The sandbox `.env` is already using the valid key, so the deployed
preview and production sites are unaffected — this fix is only needed
for your local machine.

## Technical details

- File read: `.env` (upload), `src/integrations/supabase/client.ts`,
  `client.server.ts`, `.env.example`.
- JWT decoded with standard base64url; payload failed `JSON.parse` at
  column 75 (the `b` in `1781843b52`).
- No code, migration, or secret changes are proposed — this plan is
  diagnostic only plus a one-line local `.env` replacement you perform
  on your machine.
