import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtSAR } from "@/lib/branches";

/**
 * Lightweight Saudi Arabia sales heat map — inline SVG, no external deps.
 * Matches city names in English or Arabic; bubbles sized by completed sales.
 */

// Approximate lat/lon for major Saudi cities. Keys stored in normalized form.
const CITY_COORDS: Record<string, [number, number]> = {
  // English
  riyadh: [46.6753, 24.7136],
  jeddah: [39.1925, 21.4858],
  mecca: [39.8579, 21.3891],
  makkah: [39.8579, 21.3891],
  medina: [39.6142, 24.4686],
  madinah: [39.6142, 24.4686],
  dammam: [50.1033, 26.4207],
  khobar: [50.2083, 26.2172],
  dhahran: [50.1033, 26.2361],
  qatif: [50.0089, 26.5205],
  jubail: [49.6225, 27.0046],
  hofuf: [49.5877, 25.3548],
  ahsa: [49.5877, 25.3548],
  ihsa: [49.5877, 25.3548],
  taif: [40.4155, 21.2703],
  abha: [42.5053, 18.2164],
  khamis: [42.7326, 18.306],
  najran: [44.1277, 17.4924],
  jazan: [42.5511, 16.8892],
  jizan: [42.5511, 16.8892],
  bisha: [42.5906, 20.0],
  tabuk: [36.5662, 28.3838],
  hail: [41.6907, 27.5219],
  buraidah: [43.9757, 26.326],
  qassim: [43.9757, 26.326],
  unaizah: [43.9931, 26.0843],
  yanbu: [38.0618, 24.0895],
  rabigh: [39.0347, 22.7986],
  kharj: [47.305, 24.1556],
  arar: [41.0381, 30.9753],
  sakaka: [40.2064, 29.9697],
  qurayyat: [37.3353, 31.332],
  hafar: [45.9636, 28.4337],
  baha: [41.4677, 20.0129],
  rafha: [43.4939, 29.6202],
  // Arabic
  "الرياض": [46.6753, 24.7136],
  "جدة": [39.1925, 21.4858],
  "مكة": [39.8579, 21.3891],
  "المدينة": [39.6142, 24.4686],
  "الدمام": [50.1033, 26.4207],
  "الخبر": [50.2083, 26.2172],
  "الظهران": [50.1033, 26.2361],
  "القطيف": [50.0089, 26.5205],
  "الجبيل": [49.6225, 27.0046],
  "الهفوف": [49.5877, 25.3548],
  "الإحساء": [49.5877, 25.3548],
  "الاحساء": [49.5877, 25.3548],
  "الطائف": [40.4155, 21.2703],
  "أبها": [42.5053, 18.2164],
  "خميس مشيط": [42.7326, 18.306],
  "نجران": [44.1277, 17.4924],
  "جازان": [42.5511, 16.8892],
  "بيشة": [42.5906, 20.0],
  "تبوك": [36.5662, 28.3838],
  "حائل": [41.6907, 27.5219],
  "بريدة": [43.9757, 26.326],
  "القصيم": [43.9757, 26.326],
  "عنيزة": [43.9931, 26.0843],
  "ينبع": [38.0618, 24.0895],
  "رابغ": [39.0347, 22.7986],
  "الخرج": [47.305, 24.1556],
  "عرعر": [41.0381, 30.9753],
  "سكاكا": [40.2064, 29.9697],
  "القريات": [37.3353, 31.332],
  "حفر الباطن": [45.9636, 28.4337],
  "الباحة": [41.4677, 20.0129],
  "رفحاء": [43.4939, 29.6202],
};

// Simplified Saudi Arabia outline (rough polygon in lon,lat)
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

// Projection bounds — add small padding so bubbles near edges aren't clipped
const LON_MIN = 33.5, LON_MAX = 56.5;
const LAT_MIN = 15.5, LAT_MAX = 32.8;
// Keep viewBox aspect ratio equal to lon:lat span so the country isn't squished
const W = 800;
const H = Math.round((W * (LAT_MAX - LAT_MIN)) / (LON_MAX - LON_MIN)); // ≈ 602

function project(lon: number, lat: number): [number, number] {
  const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * W;
  const y = H - ((lat - LAT_MIN) / (LAT_MAX - LAT_MIN)) * H;
  return [x, y];
}

function normalizeCity(s: string): string {
  return s.toLowerCase().trim()
    .replace(/^al[- ]/, "")
    .replace(/^ال/, "")
    .replace(/[’'ـ]/g, "");
}

function lookupCoords(name: string): [number, number] | undefined {
  if (CITY_COORDS[name]) return CITY_COORDS[name];
  const key = normalizeCity(name);
  if (CITY_COORDS[key]) return CITY_COORDS[key];
  const hit = Object.entries(CITY_COORDS).find(([k]) => {
    const nk = normalizeCity(k);
    return nk && (nk === key || nk.includes(key) || key.includes(nk));
  });
  return hit?.[1];
}

export interface CitySales {
  name: string;
  sales: number;      // completed sales value
  count: number;      // orders count
  total?: number;     // total sales value (all statuses)
  completed?: number; // completed orders count
}

export function SaudiSalesMap({ cities }: { cities: CitySales[] }) {
  const [hover, setHover] = useState<null | { x: number; y: number; d: CitySales }>(null);

  const points = useMemo(() => {
    return cities
      .map((c) => {
        const coords = lookupCoords(c.name);
        if (!coords) return null;
        return { ...c, lon: coords[0], lat: coords[1] };
      })
      .filter((p): p is CitySales & { lon: number; lat: number } => !!p);
  }, [cities]);

  const maxSales = Math.max(1, ...points.map((p) => p.sales));

  const outlinePath = useMemo(
    () =>
      "M " +
      KSA_OUTLINE.map(([lon, lat]) => {
        const [x, y] = project(lon, lat);
        return `${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(" L ") +
      " Z",
    [],
  );

  const heatColor = (ratio: number) => {
    if (ratio < 0.33) return "hsl(160 84% 39%)";
    if (ratio < 0.66) return "hsl(38 92% 50%)";
    return "hsl(0 84% 60%)";
  };

  const unmapped = cities.filter((c) => !lookupCoords(c.name));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Sales by city — Saudi Arabia</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative w-full overflow-hidden rounded-md border bg-gradient-to-b from-sky-50/60 to-transparent dark:from-sky-500/5">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-auto max-h-[360px]"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Saudi Arabia sales heat map"
          >
            <path
              d={outlinePath}
              className="fill-muted stroke-border"
              fillOpacity={0.6}
              strokeWidth={1.25}
            />
            {points.map((p) => {
              const [cx, cy] = project(p.lon, p.lat);
              const ratio = p.sales / maxSales;
              const r = 5 + Math.sqrt(ratio) * 22;
              const color = heatColor(ratio);
              return (
                <g
                  key={p.name}
                  onMouseEnter={() => setHover({ x: cx, y: cy, d: p })}
                  onMouseLeave={() => setHover(null)}
                  className="cursor-pointer transition-opacity hover:opacity-90"
                >
                  <circle cx={cx} cy={cy} r={r} fill={color} fillOpacity={0.28} stroke={color} strokeWidth={1.5} />
                  <circle cx={cx} cy={cy} r={2.5} fill={color} />
                </g>
              );
            })}
          </svg>
          {hover && (
            <div
              className="pointer-events-none absolute z-10 min-w-[180px] rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
              style={{
                left: `${(hover.x / W) * 100}%`,
                top: `${(hover.y / H) * 100}%`,
                transform: "translate(-50%, calc(-100% - 10px))",
              }}
            >
              <div className="mb-1 font-semibold">{hover.d.name}</div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Total sales</span><span className="tabular-nums">{fmtSAR(hover.d.total ?? hover.d.sales)}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Completed</span><span className="tabular-nums">{fmtSAR(hover.d.sales)}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Orders</span><span className="tabular-nums">{hover.d.count}</span></div>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "hsl(160 84% 39%)" }} /> Low</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "hsl(38 92% 50%)" }} /> Medium</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: "hsl(0 84% 60%)" }} /> High</span>
          <span className="ml-auto">Bubble size ∝ completed sales</span>
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
