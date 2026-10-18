/** Lineáris skála: [d0, d1] tartományt [r0, r1]-re képez. */
export function linear(d0: number, d1: number, r0: number, r1: number) {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * „Kerek” tengelyfeliratok (1, 2, 5 × 10^n lépésekkel), kb. `count` darab. Az első felirat a minimum alatti, az
 * utolsó a maximum feletti legközelebbi kerek érték, így a feliratok a teljes adattartományt lefedik.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const first = Math.floor(min / step + 1e-9);
  const last = Math.ceil(max / step - 1e-9);
  // A lépésszámmal szorozva (nem összeadogatva) nem halmozódik a lebegőpontos hiba
  return Array.from({ length: last - first + 1 }, (_, i) => parseFloat(((first + i) * step).toPrecision(12)));
}

/** A tengely tartománya a kerek feliratokhoz igazítva (az első és az utolsó felirat). */
export function niceDomain(min: number, max: number, count = 5): [number, number] {
  const ticks = niceTicks(min, max, count);
  return ticks.length >= 2 ? [ticks[0], ticks[ticks.length - 1]] : [min, max];
}

export const formatNumber = (v: number, digits = 2) => v.toLocaleString('hu-HU', { maximumFractionDigits: digits });

/** Tömör szám a tengelyhez: 1 200 → 1,2 E. */
export function formatCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${formatNumber(v / 1_000_000, 1)} M`;
  if (abs >= 1_000) return `${formatNumber(v / 1_000, 1)} E`;
  return formatNumber(v, abs < 10 ? 2 : 1);
}

export const formatDate = (ms: number) =>
  new Date(ms).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });

export const formatDateLong = (ms: number) =>
  new Date(ms).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' });

/** Időtengely feliratai: kb. `count` egyenletesen elosztott nap éjfélkor. */
export function timeTicks(t0: number, t1: number, count = 6): number[] {
  const day = 86_400_000;
  const step = Math.max(day, Math.ceil((t1 - t0) / count / day) * day);
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / day) * day; t <= t1; t += step) ticks.push(t);
  return ticks;
}

/** Lépcsős idősor értéke t időpontban (az utolsó, t-nél nem későbbi pont); t előtt null. */
export function stepValueAt(points: { t: number; v: number }[], t: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0 || points[0].t > t) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return points[lo].v;
}
