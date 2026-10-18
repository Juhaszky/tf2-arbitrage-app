import { config } from '../config';
import { FileStore } from '../storage/file.store';

export interface TrackedItem {
  sku: string;
  name: string;
  /** Küldjön-e Discord értesítést, ha az ajánlás BUY-ra vált (vagy már nem az). */
  notify: boolean;
  addedAt: string;
}

const FILE = 'tracked.json';

/**
 * A követett tárgyak listája (data/tracked.json). Ha a fájl még nem létezik,
 * a .env-ben megadott TRACKED_SKUS lesz a kezdőlista.
 */
export class TrackingService {
  private cache?: TrackedItem[];

  constructor(private store = new FileStore(config.dataDir)) {}

  async list(): Promise<TrackedItem[]> {
    if (!this.cache) {
      const stored = await this.store.read<TrackedItem[] | null>(FILE, null);
      this.cache = stored ?? config.collector.trackedSkus.map((sku) => ({
        sku, name: sku, notify: true, addedAt: new Date().toISOString(),
      }));
      if (!stored) await this.save();
    }
    return this.cache;
  }

  async get(sku: string) {
    return (await this.list()).find((i) => i.sku === sku);
  }

  /** Hozzáadja a tárgyat; ha már követett, a meglévőt adja vissza (created: false). */
  async add(sku: string, name: string, notify = true) {
    const existing = await this.get(sku);
    if (existing) return { item: existing, created: false };
    const item: TrackedItem = { sku, name, notify, addedAt: new Date().toISOString() };
    this.cache!.push(item);
    await this.save();
    return { item, created: true };
  }

  async update(sku: string, changes: Partial<Pick<TrackedItem, 'notify' | 'name'>>) {
    const item = await this.get(sku);
    if (!item) return undefined;
    Object.assign(item, changes);
    await this.save();
    return item;
  }

  async remove(sku: string): Promise<boolean> {
    const items = await this.list();
    const index = items.findIndex((i) => i.sku === sku);
    if (index === -1) return false;
    items.splice(index, 1);
    await this.save();
    return true;
  }

  private save() {
    return this.store.write(FILE, this.cache ?? []);
  }
}

export const trackingService = new TrackingService();
