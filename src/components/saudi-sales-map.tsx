import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtSAR } from "@/lib/branches";

/**
 * Lightweight Saudi Arabia sales heat map.
 * Uses an inline simplified SVG outline + equirectangular projection to plot
 * city bubbles sized/colored by completed-sales value. Zero external deps.
 */

// Approximate lat/lon for major Saudi cities (case-insensitive match on `city`)
const CITY_COORDS: Record<string, [number, number]> = {
  riyadh: [46.6753, 24.7136],
  jeddah: [39.1925, 21.4858],
  mecca: [39.8579, 21.3891],
  makkah: [39.8579, 21.3891],
  medina: [39.6142, 24.4686],
  madinah: [39.6142, 24.4686],
  dammam: [50.1033, 26.4207],
  khobar: [50.2083, 26.2172],
  "al khobar": [50.2083, 26.2172],
  dhahran: [50.1033, 26.2361],
  qatif: [50.0089, 26.5205],
  jubail: [49.6225, 27.0046],
  hofuf: [49.5877, 25.3548],
  ahsa: [49.5877, 25.3548],
  "al ahsa": [49.5877, 25.3548],
  taif: [40.4155, 21.2703],
  abha: [42.5053, 18.2164],
  khamis: [42.7326, 18.3060],
  "khamis mushait": [42.7326, 18.3060],
  najran: [44.1277, 17.4924],
  jazan: [42.5511, 16.8892],
  jizan: [42.5511, 16.8892],
  bisha: [42.5906, 20.0000],
  tabuk: [36.5662, 28.3838],
  hail: [41.6907, 27.5219],
  buraidah: [43.9757, 26.3260],
  buraydah: [43.9757, 26.3260],
  unaizah: [43.9931, 26.0843],
  yanbu: [38.0618, 24.0895],
  rabigh: [39.0347, 22.7986],
  "al kharj": [47.3050, 24.1556],
  kharj: [47.3050, 24.1556],
  arar: [41.0381, 30.9753],
  sakaka: [40.2064, 29.9697],
  qurayyat: [37.3353, 31.3320],
  "hafar al batin": [45.9636, 28.4337],
  hafar: [45.9636, 28.4337],
  baha: [41.4677, 20.0129],
  "al baha": [41.4677, 20.0129],
};

// Simplified Saudi Arabia outline (rough polygon in lon,lat) for silhouette
const KSA_OUTLINE: Array<[number, number]> = [
  [34.6, 28.1], [36.0, 29.3], [37.5, 29.9], [38.6, 30.5], [39.2, 32.15],
  [42.0, 31.1], [45.0, 29.2], [46.4, 29.1], [47.6, 29.9], [48.5, 29.0],
  [50.0, 28.5], [50.2, 27.5], [50.5, 26.6], [50.8, 25.0], [51.6, 24.6],
  [52.6, 22.9], [55.2, 22.7], [55.7, 20.0], [52.0, 19.0], [49.5, 18.8],
  [47.5, 17.2], [46.6, 17.3], [45.2, 17.4], [43.4, 16.7], [43.2, 16.4],
  [42.8, 16.4], [42.6, 17.5], [42.3, 18.2], [41.7, 18.6], [41.2, 19.4],
  [40.6, 19.9], [39.6, 20.5], [39.1, 21.4], [38.9, 22.5], [38.3, 23.8],
  [37.4, 24.6], [36.7, 25.6], [36.0, 26.5], [35.2, 27.4], [34.6, 28.1],
];

// Projection bounds (padding around KSA)
const LON_MIN = 34.0, LON_MAX = 56.0;
const LAT_MIN = 16.0, LAT_MAX = 33.0;
const W = 800, H = 620;

function project(lon: number, lat: number): [number, number] {
  const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * W;
  const y = H - ((lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * H;
  return [x, y];
}

function normalizeCity(s: string): string {
  return s.toLowerCase().trim().replace(/^al[- ]/, "").replace(/[’']/g, "");
}

export interface CitySales { name: string; sales: number; count: number }

export function SaudiSalesMap({ cities }: { cities: CitySales[] }) {
  const points = useMemo(() => {
    return cities
      .map((c) => {
        const key = normalizeCity(c.name);
        const coords =
          CITY_COORDS[key] ??
          CITY_COORDS[key.replace(/^al /, "")] ??
          Object.entries(CITY_COORDS).find(([k]) => key.includes(k) || k.includes(key))?.[1];
        if (!coords) return null;
        return { ...c, lon: coords[0], lat: coords[1] };
      })
      .filter((p): p is CitySales & { lon: number; lat: number } => !!p);
  }, [cities]);

  const maxSales = Math.max(1, ...points.map((p) => p.sales));
  const outlinePath =
    "M " +
    KSA_OUTLINE.map(([lon, lat]) => {
      const [x, y] = project(lon, lat);
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" L ") +
    " Z";

  const heatColor = (ratio: number) => {
    // green -> amber -> red
    if (ratio < 0.33) return "#10b981";
    if (ratio < 0.66) return "#f59e0b";
    return "#ef4444";
  };

  const unmapped = cities.filter(
    (c) =>
      !CITY_COORDS[normalizeCity(c.name)] &&
      !Object.keys(CITY_COORDS).some((k) => {
        const nk = normalizeCity(c.name);
        return nk.includes(k) || k.includes(nk);
      }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sales heat map — Saudi Arabia</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="w-full overflow-hidden rounded-md border bg-gradient-to-b from-sky-50/60 to-transparent dark:from-sky-500/5">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Saudi Arabia sales heat map">
            <path d={outlinePath} fill="hsl(var(--muted) / 0.55)" stroke="hsl(var(--border))" strokeWidth={1.5} />
            {points.map((p) => {
              const [cx, cy] = project(p.lon, p.lat);
              const ratio = p.sales / maxSales;
              const r = 6 + Math.sqrt(ratio) * 28;
              const color = heatColor(ratio);
              return (
                <g key={p.name}>
                  <circle cx={cx} cy={cy} r={r} fill={color} fillOpacity={0.35} stroke={color} strokeWidth={1.5}>
                    <title>{`${p.name}: ${fmtSAR(p.sales)} · ${p.count} orders`}</title>
                  </circle>
                  <circle cx={cx} cy={cy} r={2.5} fill={color} />
                  <text x={cx + r + 3} y={cy + 3} fontSize={11} fill="hsl(var(--foreground))" className="pointer-events-none">
                    {p.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Low</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Medium</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500" /> High</span>
          <span className="ml-auto">Bubble size ∝ completed sales value</span>
        </div>
        {unmapped.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Not plotted (unknown coordinates): {unmapped.map((u) => u.name).join(", ")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
