import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtSAR } from "@/lib/branches";

/**
 * Saudi Arabia sales heat map — enterprise-grade inline SVG.
 * No external deps. Brand palette, smooth animations, collision-aware labels.
 */

// Approximate lat/lon for major Saudi cities. Keys stored in normalized form.
const CITY_COORDS: Record<string, [number, number]> = {
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

// More detailed Saudi Arabia outline (lon, lat pairs)
const KSA_OUTLINE: Array<[number, number]> = [
  [34.95, 29.35], [36.02, 29.19], [36.48, 29.50], [36.75, 29.87], [37.49, 29.99],
  [37.98, 30.50], [36.96, 31.49], [38.00, 31.99], [39.15, 32.14], [40.37, 31.93],
  [42.08, 31.08], [42.85, 30.49], [44.72, 29.19], [46.36, 29.06], [46.55, 29.10],
  [47.46, 29.98], [48.02, 29.54], [48.42, 28.54], [48.83, 28.06], [49.30, 27.46],
  [49.98, 27.03], [50.24, 26.35], [50.56, 26.05], [50.20, 25.61], [50.56, 25.00],
  [51.28, 24.62], [51.60, 24.14], [52.56, 22.94], [55.20, 22.70], [55.67, 22.00],
  [55.20, 20.55], [52.00, 19.00], [49.50, 19.20], [48.19, 18.16], [47.58, 17.45],
  [46.72, 17.30], [45.42, 17.33], [43.79, 16.36], [43.19, 16.66], [42.78, 16.38],
  [42.65, 16.77], [42.35, 17.68], [42.11, 18.36], [41.68, 18.68], [41.22, 19.42],
  [40.65, 19.86], [39.62, 20.50], [39.10, 21.29], [38.99, 22.06], [38.46, 23.72],
  [37.16, 24.88], [36.68, 25.61], [35.90, 26.53], [35.15, 27.44], [34.63, 28.06],
  [34.95, 29.35],
];

// Projection bounds
const LON_MIN = 33.5, LON_MAX = 56.5;
const LAT_MIN = 15.5, LAT_MAX = 32.8;
const W = 900;
const H = Math.round((W * (LAT_MAX - LAT_MIN)) / (LON_MAX - LON_MIN));

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
  sales: number;
  count: number;
  total?: number;
  completed?: number;
}

type Placed = CitySales & {
  lon: number; lat: number;
  cx: number; cy: number;
  r: number;
  ratio: number;
  color: string;
  labelX: number;
  labelY: number;
  anchor: "start" | "end" | "middle";
};

export function SaudiSalesMap({ cities }: { cities: CitySales[] }) {
  const [hoverName, setHoverName] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setMounted(true), 30);
    return () => window.clearTimeout(t);
  }, []);

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
    // Brand: turquoise → amber → red
    if (ratio < 0.34) return "hsl(184 66% 44%)"; // turquoise
    if (ratio < 0.67) return "hsl(38 92% 50%)";  // amber
    return "hsl(0 78% 58%)";                     // red
  };

  const placed: Placed[] = useMemo(() => {
    const raw = cities
      .map((c) => {
        const coords = lookupCoords(c.name);
        if (!coords) return null;
        const [lon, lat] = coords;
        const [cx, cy] = project(lon, lat);
        return { c, lon, lat, cx, cy };
      })
      .filter((v): v is NonNullable<typeof v> => !!v);

    const maxSales = Math.max(1, ...raw.map((p) => p.c.sales));

    // Sort by sales desc so largest bubbles get first pick on labels
    raw.sort((a, b) => b.c.sales - a.c.sales);

    // Padding from map edges so labels never clip
    const PAD = 10;
    // label collision — occupied rects
    const placedLabels: { x: number; y: number; w: number; h: number }[] = [];
    const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
      placedLabels.some((p) => !(r.x + r.w < p.x || p.x + p.w < r.x || r.y + r.h < p.y || p.y + p.h < r.y));

    const out: Placed[] = raw.map(({ c, lon, lat, cx, cy }) => {
      const ratio = c.sales / maxSales;
      const r = 6 + Math.sqrt(ratio) * 26;
      const color = heatColor(ratio);
      const labelW = Math.max(44, c.name.length * 7.6) + 6;
      const labelH = 16;
      const gap = 8;

      // 8 candidate positions around the bubble, then longer offsets as fallback
      const build = (dist: number) => [
        { x: cx + r + dist, y: cy + 4, anchor: "start" as const },
        { x: cx - r - dist, y: cy + 4, anchor: "end" as const },
        { x: cx, y: cy - r - dist, anchor: "middle" as const },
        { x: cx, y: cy + r + dist + labelH - 4, anchor: "middle" as const },
        { x: cx + r + dist * 0.7, y: cy - r - dist * 0.4, anchor: "start" as const },
        { x: cx - r - dist * 0.7, y: cy - r - dist * 0.4, anchor: "end" as const },
        { x: cx + r + dist * 0.7, y: cy + r + dist * 0.4 + labelH - 4, anchor: "start" as const },
        { x: cx - r - dist * 0.7, y: cy + r + dist * 0.4 + labelH - 4, anchor: "end" as const },
      ];

      const rectFor = (cand: { x: number; y: number; anchor: "start" | "end" | "middle" }) => {
        const rectX = cand.anchor === "start" ? cand.x : cand.anchor === "end" ? cand.x - labelW : cand.x - labelW / 2;
        return { x: rectX, y: cand.y - labelH + 2, w: labelW, h: labelH };
      };

      let chosen: { x: number; y: number; anchor: "start" | "end" | "middle" } | null = null;
      for (const dist of [gap, gap + 8, gap + 18, gap + 30]) {
        for (const cand of build(dist)) {
          const rect = rectFor(cand);
          if (rect.x < PAD || rect.x + rect.w > W - PAD || rect.y < PAD || rect.y + rect.h > H - PAD) continue;
          if (!overlaps(rect)) { chosen = cand; placedLabels.push(rect); break; }
        }
        if (chosen) break;
      }

      if (!chosen) {
        // Last resort: clamp inside bounds, allow overlap
        for (const cand of build(gap)) {
          const rect = rectFor(cand);
          const clampedX = Math.min(Math.max(rect.x, PAD), W - PAD - rect.w);
          const clampedY = Math.min(Math.max(rect.y, PAD), H - PAD - rect.h);
          const dx = clampedX - rect.x;
          const dy = clampedY - rect.y;
          chosen = { x: cand.x + dx, y: cand.y + dy, anchor: cand.anchor };
          placedLabels.push({ ...rect, x: clampedX, y: clampedY });
          break;
        }
      }

      return {
        ...c, lon, lat, cx, cy, r, ratio, color,
        labelX: chosen!.x, labelY: chosen!.y, anchor: chosen!.anchor,
      };
    });

    return out;
  }, [cities]);

  const hover = placed.find((p) => p.name === hoverName) ?? null;
  const unmapped = cities.filter((c) => !lookupCoords(c.name));

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span>Sales by city — Saudi Arabia</span>
          <span className="text-[11px] font-normal text-muted-foreground">
            {placed.length} {placed.length === 1 ? "city" : "cities"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative w-full overflow-hidden rounded-xl border bg-gradient-to-br from-[oklch(0.98_0.015_195)] via-background to-background dark:from-[oklch(0.22_0.03_200)]">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full h-auto"
            style={{ maxHeight: "min(64vh, 520px)" }}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Saudi Arabia sales heat map"
          >
            <defs>
              <linearGradient id="ksa-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(184 40% 92%)" stopOpacity="0.9" />
                <stop offset="100%" stopColor="hsl(200 30% 88%)" stopOpacity="0.6" />
              </linearGradient>
              <filter id="ksa-shadow" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="2.5" />
                <feOffset dx="0" dy="2" result="offset" />
                <feComponentTransfer><feFuncA type="linear" slope="0.15" /></feComponentTransfer>
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="bubble-shadow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
                <feOffset dx="0" dy="1.5" result="offset" />
                <feComponentTransfer><feFuncA type="linear" slope="0.35" /></feComponentTransfer>
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="hsl(200 30% 90%)" strokeWidth="0.5" opacity="0.4" />
              </pattern>
            </defs>

            <rect width={W} height={H} fill="url(#grid)" />

            <path
              d={outlinePath}
              fill="url(#ksa-fill)"
              stroke="hsl(184 30% 55%)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              filter="url(#ksa-shadow)"
            />

            {/* Label leader lines — drawn largest-last so top bubbles' lines sit above */}
            {[...placed].reverse().map((p) => {
              const active = hoverName === p.name;
              const tx = p.anchor === "start" ? p.labelX - 2 : p.anchor === "end" ? p.labelX + 2 : p.labelX;
              const ty = p.anchor === "middle" && p.labelY < p.cy ? p.labelY + 3 : p.labelY - 4;
              return (
                <line key={`ln-${p.name}`}
                  x1={p.cx} y1={p.cy} x2={tx} y2={ty}
                  stroke="hsl(200 15% 60%)" strokeWidth={0.6} opacity={active ? 0.9 : 0.35}
                />
              );
            })}

            {/* Bubbles — render smallest first so the largest bubble paints on top */}
            {[...placed].reverse().map((p, i) => {
              const active = hoverName === p.name;
              return (
                <g key={p.name}
                  onMouseEnter={() => setHoverName(p.name)}
                  onMouseLeave={() => setHoverName((n) => (n === p.name ? null : n))}
                  style={{
                    cursor: "pointer",
                    transformOrigin: `${p.cx}px ${p.cy}px`,
                    transform: mounted ? "scale(1)" : "scale(0)",
                    opacity: mounted ? 1 : 0,
                    transition: `transform 480ms cubic-bezier(.34,1.4,.5,1) ${i * 40}ms, opacity 320ms ease ${i * 40}ms`,
                  }}
                >
                  <circle cx={p.cx} cy={p.cy} r={p.r} fill={p.color} fillOpacity={active ? 0.32 : 0.22} />
                  <circle cx={p.cx} cy={p.cy} r={p.r} fill="none"
                    stroke={p.color} strokeWidth={active ? 2.25 : 1.5} strokeOpacity={0.95}
                    style={{ transition: "stroke-width 180ms ease" }}
                  />
                  <circle cx={p.cx} cy={p.cy} r={active ? 4.2 : 3.2} fill={p.color}
                    filter="url(#bubble-shadow)"
                    style={{ transition: "r 180ms ease" }}
                  />
                </g>
              );
            })}

            {/* Labels — drawn after bubbles so they sit above */}
            {placed.map((p) => {
              const active = hoverName === p.name;
              return (
                <g key={`lbl-${p.name}`} style={{
                  opacity: mounted ? 1 : 0,
                  transition: "opacity 300ms ease 250ms",
                  pointerEvents: "none",
                }}>
                  <text
                    x={p.labelX} y={p.labelY}
                    textAnchor={p.anchor}
                    fontSize={11.5}
                    fontWeight={active ? 700 : 600}
                    fill="hsl(215 28% 18%)"
                    stroke="white" strokeWidth={3.5} strokeOpacity={0.98} paintOrder="stroke"
                    style={{ letterSpacing: 0.15, fontFeatureSettings: '"kern"', textRendering: "geometricPrecision" }}
                  >
                    {p.name}
                  </text>
                </g>
              );
            })}

            {/* Raise hovered group visually by re-rendering last */}
            {hover && (
              <g style={{ pointerEvents: "none" }}>
                <circle cx={hover.cx} cy={hover.cy} r={hover.r + 3} fill="none"
                  stroke={hover.color} strokeWidth={1} strokeOpacity={0.5}>
                  <animate attributeName="r" from={hover.r} to={hover.r + 10} dur="1.2s" repeatCount="indefinite" />
                  <animate attributeName="stroke-opacity" from="0.55" to="0" dur="1.2s" repeatCount="indefinite" />
                </circle>
              </g>
            )}
          </svg>

          {hover && (() => {
            const labelAbove = hover.labelY < hover.cy;
            const leftPct = (hover.cx / W) * 100;
            const topPct = (hover.cy / H) * 100;
            const flipBelow = labelAbove || hover.cy < H * 0.35;
            const nearLeft = leftPct < 22;
            const nearRight = leftPct > 78;
            const xShift = nearLeft ? "0%" : nearRight ? "-100%" : "-50%";
            const yShift = flipBelow ? `calc(${hover.r + 16}px)` : `calc(-100% - ${hover.r + 14}px)`;
            return (
            <div
              className="pointer-events-none absolute z-10 min-w-[210px] rounded-lg border bg-popover/95 backdrop-blur px-3.5 py-2.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5"
              style={{
                left: `${leftPct}%`,
                top: `${topPct}%`,
                transform: `translate(${xShift}, ${yShift})`,
                maxWidth: "min(260px, 92vw)",
              }}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: hover.color }} />
                <span className="font-semibold text-sm">{hover.name}</span>
              </div>
              <div className="space-y-1">
                <Row label="Total sales" value={fmtSAR(hover.total ?? hover.sales)} />
                <Row label="Completed sales" value={fmtSAR(hover.sales)} strong />
                <Row label="Total orders" value={String(hover.count)} />
                <Row label="Completion rate" value={
                  hover.count > 0
                    ? `${Math.round(((hover.completed ?? 0) / hover.count) * 100)}%`
                    : "—"
                } />
              </div>
            </div>
            );
          })()}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <LegendDot color="hsl(184 66% 44%)" label="Low" />
          <LegendDot color="hsl(38 92% 50%)" label="Medium" />
          <LegendDot color="hsl(0 78% 58%)" label="High" />
          <span className="ml-auto text-[11px]">Bubble size ∝ completed sales</span>
        </div>
        {unmapped.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Not plotted: {unmapped.map((u) => u.name).join(", ")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${strong ? "font-semibold text-foreground" : ""}`}>{value}</span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full ring-2 ring-background" style={{ background: color, boxShadow: `0 0 0 1px ${color}` }} />
      {label}
    </span>
  );
}
