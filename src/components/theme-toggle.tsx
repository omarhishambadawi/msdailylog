import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  // The icons interpolate off --theme-dark rather than running their own
  // 300ms transition, so they land on exactly the same frame as the page.
  // `theme` is read only for the label.
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      className={cn("h-9 w-9 relative overflow-hidden", className)}
    >
      <Sun className="h-4 w-4 absolute theme-icon-sun" />
      <Moon className="h-4 w-4 absolute theme-icon-moon" />
    </Button>
  );
}
