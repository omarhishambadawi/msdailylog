import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";
type ThemeCtx = { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void };

const Ctx = createContext<ThemeCtx | null>(null);
const STORAGE_KEY = "milaserv.theme";
const TRANSITION_MS = 340;

function applyRaw(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

function apply(theme: Theme, animate = true) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Respect reduced-motion — swap instantly, no color transition.
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduce) { applyRaw(theme); return; }

  // Use View Transitions API for a seamless cross-fade when supported.
  // Falls back to a CSS transition class otherwise.
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(() => { applyRaw(theme); });
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

  const setTheme = (t: Theme) => {
    apply(t);
    setThemeState(t);
    try { localStorage.setItem(STORAGE_KEY, t); } catch {}
  };

  return (
    <Ctx.Provider value={{ theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") }}>
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
