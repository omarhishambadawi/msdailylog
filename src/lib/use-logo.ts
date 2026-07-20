import lightLogo from "@/assets/milaserv-logo.png.asset.json";
import darkLogo from "@/assets/milaserv-logo-dark.png.asset.json";
import { useTheme } from "@/lib/theme";

export function useLogo() {
  const { theme } = useTheme();
  return theme === "dark" ? darkLogo.url : lightLogo.url;
}
