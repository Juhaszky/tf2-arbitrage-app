import { Deal, MarketItem } from './models';
import { analysisPlans } from './trade-plan';

export type SortDir = 'asc' | 'desc';

export interface SortOption<T> {
  id: string;
  label: string;
  /** Az ésszerű alapirány (pl. haszon: csökkenő, ár: növekvő). */
  dir: SortDir;
  /** A rendezés alapja; null esetén a tétel a lista végére kerül, iránytól függetlenül. */
  value: (item: T) => number | string | null;
}

export interface SortState {
  id: string;
  dir: SortDir;
}

const best = (item: MarketItem) => analysisPlans(item)[0];

export const ITEM_SORTS: SortOption<MarketItem>[] = [
  { id: 'profit', label: 'Haszon (kulcs)', dir: 'desc', value: (i) => best(i)?.profitKeys ?? null },
  { id: 'margin', label: 'Haszonkulcs (%)', dir: 'desc', value: (i) => best(i)?.marginPercent ?? null },
  { id: 'price', label: 'Vételi ár', dir: 'asc', value: (i) => best(i)?.buyKeys ?? null },
  { id: 'saleTime', label: 'Eladási idő', dir: 'asc', value: (i) => i.analysis?.sales?.expectedDaysToSell ?? null },
  { id: 'winRate', label: 'Visszateszt nyerési arány', dir: 'desc', value: (i) => i.analysis?.risk.backtestWinRatePercent ?? null },
  { id: 'name', label: 'Név', dir: 'asc', value: (i) => i.name },
];

export const DEAL_SORTS: SortOption<Deal>[] = [
  { id: 'profit', label: 'Haszon (kulcs)', dir: 'desc', value: (d) => d.profitKeys },
  { id: 'margin', label: 'Haszonkulcs (%)', dir: 'desc', value: (d) => d.marginPercent },
  { id: 'price', label: 'Vételi ár', dir: 'asc', value: (d) => d.buy.keys },
  // Az azonnali (nem buy orderes) üzlet 0 nap; a saját buy order a becsült teljesülési idővel
  {
    id: 'fillTime',
    label: 'Teljesülési idő',
    dir: 'asc',
    value: (d) => (d.type === 'MANNCO_ORDER_TO_BPTF' ? d.estimatedFillDays : 0),
  },
  { id: 'worstProfit', label: 'Legrosszabb esetbeli haszon', dir: 'desc', value: (d) => d.worstProfitKeys },
  { id: 'name', label: 'Név', dir: 'asc', value: (d) => d.name },
];

/** Rendezett másolat; a hiányzó értékű tételek mindig a végére kerülnek, az egyenlők megtartják a sorrendjüket. */
export function sortList<T>(list: T[], options: SortOption<T>[], state: SortState): T[] {
  const option = options.find((o) => o.id === state.id) ?? options[0];
  const sign = state.dir === 'asc' ? 1 : -1;
  return list
    .map((item, index) => ({ item, index, value: option.value(item) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
      }
      const diff = typeof a.value === 'string' && typeof b.value === 'string'
        ? a.value.localeCompare(b.value, 'hu')
        : (a.value as number) - (b.value as number);
      return diff * sign || a.index - b.index;
    })
    .map((x) => x.item);
}

const STORAGE_KEY = 'tf2-arbitrage.sort';

/** A böngészőben megjegyzett rendezés (ha a tároló nem érhető el, az alapértelmezett). */
export function loadSort(view: 'analysis' | 'deals', fallback: SortState): SortState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')[view];
    return saved && typeof saved.id === 'string' && (saved.dir === 'asc' || saved.dir === 'desc') ? saved : fallback;
  } catch {
    return fallback;
  }
}

export function saveSort(view: 'analysis' | 'deals', state: SortState) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...all, [view]: state }));
  } catch {
    // A rendezés megjegyzése csak kényelmi funkció
  }
}
