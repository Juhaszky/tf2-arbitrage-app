import { config } from '../config';
import { FileStore } from '../storage/file.store';

export interface ItemPreference {
  name: string;
  /** Kérsz-e Discord értesítést, amikor a tárgy vételre vált (vagy már nem ajánlott). */
  notify: boolean;
  updatedAt: string;
}

export interface NotificationPreferences {
  /** Értesítés minden tárgyról, amelyik vételre vált – kivéve, ha a tárgynál külön ki van kapcsolva. */
  notifyAllBuys: boolean;
  /** Tárgyankénti beállítás; felülírja a `notifyAllBuys` értéket. */
  items: Record<string, ItemPreference>;
}

const FILE = 'notification-settings.json';
/** A korábbi „követett tárgyak” lista; az első induláskor innen vesszük át a tárgyankénti beállításokat. */
const LEGACY_TRACKED_FILE = 'tracked.json';

export class PreferencesService {
  private cache?: NotificationPreferences;

  constructor(private store = new FileStore(config.dataDir)) {}

  async get(): Promise<NotificationPreferences> {
    if (!this.cache) {
      const stored = await this.store.read<NotificationPreferences | null>(FILE, null);
      this.cache = stored ?? (await this.migrateLegacy());
      if (!stored) await this.save();
    }
    return this.cache;
  }

  /** Külön, tárgyankénti értesítést kértél-e erre a tárgyra (a többiről az összefoglaló szól). */
  async isItemNotified(sku: string) {
    return (await this.get()).items[sku]?.notify === true;
  }

  /** Kapjon-e értesítést erről a tárgyról (tárgyankénti beállítás, különben az általános). */
  async shouldNotify(sku: string) {
    const prefs = await this.get();
    return prefs.items[sku]?.notify ?? prefs.notifyAllBuys;
  }

  /** Azok a tárgyak, amelyekre külön értesítést kértél – ezeket mindig elemezzük, akkor is, ha az előszűrésen kiesnek. */
  async notifiedSkus(): Promise<string[]> {
    const prefs = await this.get();
    return Object.entries(prefs.items).filter(([, p]) => p.notify).map(([sku]) => sku);
  }

  async setItem(sku: string, name: string, notify: boolean) {
    const prefs = await this.get();
    const pref: ItemPreference = { name, notify, updatedAt: new Date().toISOString() };
    // A kikapcsolást csak akkor kell megjegyezni, ha az általános beállítás bekapcsolt; a bekapcsoltat
    // viszont mindig, mert azt a tárgyat akkor is elemezni kell, ha kiesik az előszűrésen
    if (!notify && !prefs.notifyAllBuys) delete prefs.items[sku];
    else prefs.items[sku] = pref;
    await this.save();
    return pref;
  }

  async setNotifyAllBuys(notifyAllBuys: boolean) {
    const prefs = await this.get();
    prefs.notifyAllBuys = notifyAllBuys;
    await this.save();
    return prefs;
  }

  private async migrateLegacy(): Promise<NotificationPreferences> {
    const legacy = await this.store.read<{ sku: string; name: string; notify?: boolean }[]>(LEGACY_TRACKED_FILE, []);
    const items: Record<string, ItemPreference> = {};
    for (const item of legacy) {
      if (item.notify !== false) items[item.sku] = { name: item.name, notify: true, updatedAt: new Date().toISOString() };
    }
    return { notifyAllBuys: false, items };
  }

  private save() {
    return this.store.write(FILE, this.cache);
  }
}

export const preferencesService = new PreferencesService();
