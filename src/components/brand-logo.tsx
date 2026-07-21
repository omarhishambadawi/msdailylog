import { useEffect } from "react";
import lightLogo from "@/assets/milaserv-logo.png.asset.json";
import darkLogo from "@/assets/milaserv-logo-dark.png.asset.json";
import { useLogo } from "@/lib/use-logo";
import { cn } from "@/lib/utils";

type BrandLogoProps = {
  size?: "sidebar" | "auth";
  className?: string;
};

const sizes = {
  sidebar: "h-10 w-10",
  auth: "h-16 w-16",
} as const;

export function BrandLogo({ size = "sidebar", className }: BrandLogoProps) {
  const logoUrl = useLogo();

  useEffect(() => {
    // Keep both immutable CDN assets decoded so changing only `src` is seamless.
    for (const src of [lightLogo.url, darkLogo.url]) {
      const image = new Image();
      image.src = src;
      void image.decode().catch(() => undefined);
    }
  }, []);

  return (
    <div className={cn("flex shrink-0 items-center justify-center", sizes[size], className)}>
      <img
        src={logoUrl}
        alt="MilaServ"
        width={512}
        height={389}
        className="block h-full w-full object-contain object-center"
      />
    </div>
  );
}