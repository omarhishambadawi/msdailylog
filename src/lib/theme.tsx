import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";
type ThemeCtx = { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void };

const Ctx = createContext<ThemeCtx | null>(null);
const STORAGE_KEY = "milaserv.theme";

/** Mirrors --theme-duration in src/styles.css. */
const TRANSITION_MS = 200;

/** Browser chrome colour (mobile address bar) — approximates --background per theme. */
const THEME_COLOR: Record<Theme, string> = { light: "#fbfdfd", dark: "#171b26" };

/*
 * Theme lives in the DOM, not in React.
 *
 * A theme change is one synchronous class flip on <html>; every colour in the
 * app resolves from that class through CSS variables and `dark:` variants, so
 * the whole tree repaints on a single frame. React is only told afterwards, and
 * only so the toggle button can label itself — no component re-renders to pick
 * up a colour, which is what used to make the sidebar logo and charts land a
 * beat after everything else.
 */
const listeners = new Set<() => void>();

function readDom(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

let current: Theme = typeof document === "undefined" ? "light" : readDom();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

const getSnapshot = () => current;
/** SSR always renders Light; the pre-hydration script fixes the DOM before paint. */
const getServerSnapshot = (): Theme => "light";

let resetTimer: ReturnType<typeof setTimeout> | undefined;

function apply(theme: Theme) {
  const root = document.documentElement;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  // Arm the transition in the same style recalculation as the colour change.
  // Transitions take their timing from the after-change style, so one pass is
  // enough — no forced reflow, no second frame, nothing to get out of step.
  if (!reduce) {
    root.classList.add("theme-switching");
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      root.classList.remove("theme-switching");
      resetTimer = undefined;
    }, TRANSITION_MS + 50);
  }

  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

function setTheme(theme: Theme) {
  if (typeof document === "undefined" || theme === current) return;
  apply(theme);
  current = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {}
  for (const cb of listeners) cb();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Keep other tabs in step.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setTheme(e.newValue === "dark" ? "dark" : "light");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<ThemeCtx>(
    () => ({ theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") }),
    [theme],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  return useContext(Ctx) ?? { theme: "light", setTheme: () => {}, toggle: () => {} };
}

/**
 * Inline script — runs synchronously before first paint to prevent FOUC.
 * Default: Light Mode. Only opts into Dark when the user has explicitly saved it.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var d=localStorage.getItem('${STORAGE_KEY}')==='dark';var r=document.documentElement;if(d)r.classList.add('dark');r.style.colorScheme=d?'dark':'light';var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',d?'${THEME_COLOR.dark}':'${THEME_COLOR.light}');}catch(e){}})();`;
