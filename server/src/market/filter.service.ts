import { config } from '../config';
import { FileStore } from '../storage/file.store';

/**
 * Tárgytípusok az SKU alapján. Az SKU második tagja a minőség (pl. `30986;11` = Strange), a Strange
 * pedig másodlagos tulajdonságként is szerepelhet (`;strange`, pl. Strange Unusual) – ez mindkét típusba beletartozik.
 */
export const QUALITIES = {
  unique: { label: 'Unique', ids: [6] },
  strange: { label: 'Strange', ids: [11] },
  unusual: { label: 'Unusual', ids: [5] },
  genuine: { label: 'Genuine', ids: [1] },
  vintage: { label: 'Vintage', ids: [3] },
  haunted: { label: 'Haunted', ids: [13] },
  collectors: { label: "Collector's", ids: [14] },
  decorated: { label: 'Decorated', ids: [15] },
  selfmade: { label: 'Self-Made', ids: [9] },
  normal: { label: 'Normal', ids: [0] },
} as const;

export type Quality = keyof typeof QUALITIES;

export interface MarketFilter {
  /** A vételi ár alsó határa kulcsban (null: nincs). */
  minKeys: number | null;
  /** A vételi ár felső határa kulcsban (null: nincs). */
  maxKeys: number | null;
  /** A megengedett típusok; üres lista esetén mind. */
  qualities: Quality[];
}

const FILE = 'market-filter.json';
const EMPTY: MarketFilter = { minKeys: null, maxKeys: null, qualities: [] };

export const isQuality = (value: unknown): value is Quality => typeof value === 'string' && value in QUALITIES;

/** Az SKU-hoz tartozó típusok (egy tárgy több típusba is tartozhat, pl. Strange Unusual). */
export function qualitiesOf(sku: string): Quality[] {
  const parts = sku.split(';');
  const id = Number(parts[1]);
  const result = (Object.keys(QUALITIES) as Quality[]).filter((q) => (QUALITIES[q].ids as readonly number[]).includes(id));
  if (parts.includes('strange') && !result.includes('strange')) result.push('strange');
  return result;
}

/** Megfelel-e a tárgy a szűrőnek a vételi ára és az SKU-ja alapján. */
export function matchesFilter(filter: MarketFilter, sku: string, buyKeys: number) {
  if (filter.minKeys !== null && buyKeys < filter.minKeys) return false;
  if (filter.maxKeys !== null && buyKeys > filter.maxKeys) return false;
  return filter.qualities.length === 0 || qualitiesOf(sku).some((q) => filter.qualities.includes(q));
}

/** A piaci szűrő (data/market-filter.json): az előszűrés csak a megfelelő tárgyak közül választ jelölteket. */
export class FilterService {
  private cache?: MarketFilter;

  constructor(private store = new FileStore(config.dataDir)) {}

  async get(): Promise<MarketFilter> {
    this.cache ??= { ...EMPTY, ...(await this.store.read<Partial<MarketFilter>>(FILE, {})) };
    return this.cache;
  }

  async set(filter: MarketFilter) {
    this.cache = filter;
    await this.store.write(FILE, filter);
    return filter;
  }
}

export const filterService = new FilterService();
