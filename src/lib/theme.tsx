import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";
export type ThemeOrigin = { x: number; y: number };
type ThemeCtx = {
  theme: Theme;
  setTheme: (t: Theme, origin?: ThemeOrigin) => void;
  toggle: (origin?: ThemeOrigin) => void;
};

const Ctx = createContext<ThemeCtx | null>(null);
const STORAGE_KEY = "milaserv.theme";
const TRANSITION_MS = 320;
const REVEAL_MS = 420;

function applyRaw(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<void> };
};

function apply(theme: Theme, animate = true, origin?: ThemeOrigin) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Respect reduced-motion — swap instantly, no color transition.
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduce) { applyRaw(theme); return; }

  // Use the View Transitions API for a premium "reveal" that radiates from the
  // toggle button, rather than the default full-page opacity crossfade (which
  // double-exposes the old/new screenshots and reads as a page reload/flash).
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition === "function") {
    const { x, y } = origin ?? { x: window.innerWidth - 32, y: 24 };
    const maxRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );
    const transition = doc.startViewTransition(() => { applyRaw(theme); });
    transition.ready
      .then(() => {
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxRadius}px at ${x}px ${y}px)`] },
          { duration: REVEAL_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
        );
      })
      .catch(() => {});
    return;
  }

  root.classList.add("theme-transition");
  applyRaw(theme);
  window.setTimeout(() => root.classList.remove("theme-transition"), TRANSITION_MS);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof document === "undefined") return "light";
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  });

  useEffect(() => {
    // Sync from any pre-hydration state set by inline no-flicker script.
    const initial = document.documentElement.classList.contains("dark") ? "dark" : "light";
    setThemeState(initial);
    // Only follow OS changes if user hasn't made an explicit choice.
    // Default behaviour is Light unless the user opts in to Dark, so this
    // listener effectively only reacts if a stored preference exists.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      try { if (localStorage.getItem(STORAGE_KEY)) return; } catch {}
      // No stored pref → keep Light regardless of OS.
      void e;
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const setTheme = (t: Theme, origin?: ThemeOrigin) => {
    apply(t, true, origin);
    setThemeState(t);
    try { localStorage.setItem(STORAGE_KEY, t); } catch {}
  };

  return (
    <Ctx.Provider value={{ theme, setTheme, toggle: (origin) => setTheme(theme === "dark" ? "light" : "dark", origin) }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) return { theme: "light" as Theme, setTheme: () => {}, toggle: () => {} };
  return v;
}

/**
 * Inline script — runs synchronously before hydration to prevent FOUC.
 * Default: Light Mode. Only opts into Dark when the user has explicitly saved it.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k='${STORAGE_KEY}';var s=localStorage.getItem(k);var d=s==='dark';var r=document.documentElement;if(d){r.classList.add('dark');}r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
