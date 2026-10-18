// Kis statisztikai segédfüggvények az arbitrázs-elemzéshez.

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const median = (values: number[]) => quantile(values, 0.5);

export const mean = (values: number[]) =>
  values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Robusztus szórásbecslés (normális eloszlásnál a szórással egyezik).
 * MAD alapú; ha a MAD 0 (az értékek többsége azonos), az átlagos abszolút
 * eltérésből számol (Iglewicz–Hoaglin).
 */
export function robustSpread(values: number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  const mad = median(deviations);
  if (mad > 0) return 1.4826 * mad;
  return 1.2533 * mean(deviations);
}

/** Módosított z-érték: |z| > 3.5 felett az érték kiugrónak számít. */
export function robustZScores(values: number[]): number[] {
  const med = median(values);
  const spread = robustSpread(values);
  return values.map((v) => (spread > 0 ? (v - med) / spread : 0));
}

/**
 * Wilson-féle alsó konfidenciahatár egy arányra: a valódi arány ennél
 * (alapból 90%-os egyoldali biztonsággal) nem kisebb. Kevés mintánál óvatosabb.
 */
export function wilsonLowerBound(successes: number, trials: number, z = 1.2816): number {
  if (trials === 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (center - margin) / (1 + z2 / trials));
}

/** Theil–Sen meredekség: a páronkénti meredekségek mediánja, a kiugró értékekre érzéketlen. */
export function theilSenSlope(xs: number[], ys: number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
    }
  }
  return slopes.length === 0 ? 0 : median(slopes);
}
