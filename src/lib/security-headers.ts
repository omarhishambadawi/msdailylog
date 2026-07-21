/**
 * Security response headers.
 *
 * Applied in src/server.ts so they cover every server response -- SSR
 * documents, /api routes, server functions and the MCP endpoints -- rather than
 * only the static assets a host-level `_headers` file would reach.
 *
 * CSP is deliberately split in two:
 *
 *   - An ENFORCED policy limited to directives that cannot break a working app:
 *     frame-ancestors, base-uri, object-src, form-action. These block
 *     clickjacking, base-tag injection, plugin injection and form exfiltration
 *     outright, and none of them affect how scripts, styles or images load.
 *
 *   - A REPORT-ONLY policy carrying the full default-src/script-src/connect-src
 *     lockdown. TanStack Start injects inline hydration scripts and Radix sets
 *     inline style attributes, so a strict script-src/style-src needs nonce
 *     plumbing through the SSR renderer. Shipping that enforced, untested,
 *     would white-screen the app. Report-only lets the policy be validated
 *     against real traffic first; promote it to enforced once the violation
 *     reports are clean.
 *
 * Nothing here weakens an existing header: values are only set when absent.
 */

/** Origins the app legitimately talks to (Supabase REST, Auth, Storage, Realtime). */
function connectSources(): string {
  const urls = new Set<string>(["'self'"]);
  for (const raw of [process.env.SUPABASE_URL, process.env.VITE_SUPABASE_URL]) {
    if (!raw) continue;
    try {
      const { origin, host } = new URL(raw);
      urls.add(origin);
      urls.add(`wss://${host}`); // realtime websockets
    } catch {
      /* malformed env value - skip rather than emit a broken directive */
    }
  }
  return [...urls].join(" ");
}

const ENFORCED_CSP = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

function reportOnlyCsp(): string {
  const connect = connectSources();
  return [
    "default-src 'self'",
    // 'unsafe-inline' is required by SSR hydration today; the value of this
    // directive is that it still blocks loading script from any foreign origin.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function applySecurityHeaders(request: Request, response: Response): Response {
  // Response headers are immutable on some runtimes; clone through a mutable set.
  const headers = new Headers(response.headers);
  const set = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };

  set("X-Content-Type-Options", "nosniff");
  set("X-Frame-Options", "DENY");
  set("Referrer-Policy", "strict-origin-when-cross-origin");
  set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
  );
  set("Content-Security-Policy", ENFORCED_CSP);
  set("Content-Security-Policy-Report-Only", reportOnlyCsp());

  // HSTS only over TLS. Emitting it on plain http is ignored by browsers, and
  // sending it from a local http dev origin would needlessly pin localhost.
  let isHttps = false;
  try {
    isHttps = new URL(request.url).protocol === "https:";
  } catch {
    /* non-absolute URL - treat as not-https */
  }
  if (isHttps) {
    // No `preload`: that is a one-way commitment for the apex domain and is the
    // domain owner's call, not something to switch on from application code.
    set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
