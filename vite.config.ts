// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";
import { VitePWA } from "vite-plugin-pwa";
import { sep } from "node:path";
import { loadEnv, type Plugin } from "vite";

// Workaround for an upstream Windows-only bug in @lovable.dev/mcp-js (present in
// every version from 0.20.0 through 0.24.0, the current latest).
//
// Its `configResolved` hook takes `config.root` — which Vite always normalizes to
// forward slashes — and compares it against `path.resolve()` output, which uses
// native separators. The containment guard is
// `child.startsWith(parent + path.sep)`, so on Windows it compares
// "C:\...\src\routes" against "C:/.../msdailylog\" and can never hold; the plugin
// throws and neither `vite dev` nor `vite build` can start. On POSIX `sep` is "/"
// and the mismatch does not exist, which is why CI and the Lovable sandbox pass.
//
// Handing that one hook a root with native separators is behaviour-neutral: the
// plugin only feeds the value to path.resolve()/path.relative(), both of which
// accept either form and produce identical output. No-op off Windows.
function withNativeSepRoot(plugin: Plugin): Plugin {
  const original = plugin.configResolved;
  if (sep === "/" || typeof original !== "function") return plugin;
  // Mutate in place rather than spreading: the plugin exposes `api.mcpEntry` as a
  // getter that is finalized during configResolved, and a spread would snapshot it.
  plugin.configResolved = function (config, ...rest) {
    const nativeRoot = new Proxy(config, {
      // Receiver is the target, not the proxy, so any getters on the resolved
      // config still see their real `this`.
      get: (target, prop) =>
        prop === "root"
          ? String(target.root).split("/").join(sep)
          : Reflect.get(target, prop, target),
    });
    return (original as (...a: unknown[]) => unknown).call(this, nativeRoot, ...rest);
  } as Plugin["configResolved"];
  return plugin;
}

// Local-dev-only bridge from `.env` into the real Node `process.env`.
//
// `@lovable.dev/vite-tanstack-config` loads `.env` with a hard `VITE_` prefix
// filter and injects the result only into `import.meta.env` for the client
// bundle — nothing ever reaches `process.env`. Server functions, however, read
// their secrets from `process.env` (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// YEASTAR_BASE_URL, YEASTAR_CLIENT_ID, YEASTAR_CLIENT_SECRET), because in
// production the Cloudflare Workers runtime materializes bound secrets there
// via unenv's process shim. Under plain `vite dev` no such bridge exists, so
// Users/Yeastar admin pages fail locally while client-side pages work.
//
// This plugin closes that gap for `vite dev` only (`command === "serve"`;
// `vite build` is untouched, so the Cloudflare/Vercel build paths and prod
// runtime behavior are unchanged). `loadEnv` with an empty prefix returns
// every key from the mode's `.env` files merged with the ambient
// `process.env`, ambient winning — so real environment variables still take
// precedence over `.env` file values, and the assign is a no-op for keys the
// shell already set.
function serverEnvBridge(): Plugin {
  return {
    name: "msdailylog:server-env-bridge",
    config(_config, { command, mode }) {
      if (command !== "serve") return;
      Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [
      serverEnvBridge(),
      withNativeSepRoot(mcpPlugin()),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: null,
        strategies: "generateSW",
        filename: "sw.js",
        manifest: false, // we ship our own /manifest.webmanifest
        devOptions: { enabled: false },
        workbox: {
          navigateFallback: null,
          globPatterns: ["**/*.{js,css,html,ico,png,svg,webp,woff2}"],
          navigateFallbackDenylist: [
            /^\/~oauth/,
            /^\/_serverFn/,
            /^\/api\//,
            /^\/\.mcp\//,
            /^\/\.well-known\//,
          ],
          runtimeCaching: [
            {
              urlPattern: ({ request, url }) =>
                request.mode === "navigate" &&
                !url.pathname.startsWith("/~oauth") &&
                !url.pathname.startsWith("/_serverFn") &&
                !url.pathname.startsWith("/api/"),
              handler: "NetworkFirst",
              options: {
                cacheName: "html-navigations",
                networkTimeoutSeconds: 4,
                expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 },
              },
            },
            {
              urlPattern: ({ request, sameOrigin }) =>
                sameOrigin && (request.destination === "script" || request.destination === "style" || request.destination === "font"),
              handler: "CacheFirst",
              options: {
                cacheName: "static-assets",
                expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              urlPattern: ({ request, sameOrigin }) => sameOrigin && request.destination === "image",
              handler: "CacheFirst",
              options: {
                cacheName: "images",
                expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
  },
});
