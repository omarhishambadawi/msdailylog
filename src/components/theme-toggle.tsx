import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        toggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      className={cn(
        "h-9 w-9 rounded-lg relative overflow-hidden text-foreground/70 transition-colors duration-200 hover:text-foreground active:scale-95",
        className,
      )}
    >
      <Sun
        className={cn(
          "h-[18px] w-[18px] absolute transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          isDark ? "opacity-0 rotate-90 scale-50" : "opacity-100 rotate-0 scale-100",
        )}
      />
      <Moon
        className={cn(
          "h-[18px] w-[18px] absolute transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          isDark ? "opacity-100 rotate-0 scale-100" : "opacity-0 -rotate-90 scale-50",
        )}
      />
    </Button>
  );
}
