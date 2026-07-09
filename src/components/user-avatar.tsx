import { cn } from "@/lib/utils";

interface UserAvatarProps {
  name?: string | null;
  url?: string | null;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeMap = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-16 w-16 text-lg",
  xl: "h-24 w-24 text-2xl",
} as const;

function initialsOf(name?: string | null) {
  if (!name) return "?";
  return name.split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

export function UserAvatar({ name, url, size = "md", className }: UserAvatarProps) {
  const cls = sizeMap[size];
  if (url) {
    return (
      <img
        src={url}
        alt={name ?? "avatar"}
        className={cn("rounded-full object-cover ring-1 ring-border shrink-0", cls, className)}
        loading="lazy"
      />
    );
  }
  return (
    <div
      className={cn(
        "rounded-full grid place-items-center bg-gradient-to-br from-primary to-secondary text-primary-foreground font-semibold shrink-0",
        cls,
        className,
      )}
      aria-label={name ?? "avatar"}
    >
      {initialsOf(name)}
    </div>
  );
}
