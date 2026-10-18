import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { bestRecommendation } from './format';
import {
  Deal,
  DealType,
  ItemSearchResult,
  MarketFilter,
  MarketItem,
  MarketResponse,
  QualityOption,
  Recommendation,
  RouteKey,
  ScreenSummary,
} from './models';
import { DEAL_SORTS, ITEM_SORTS, SortState, loadSort, saveSort, sortList } from './sorting';
import { bestRouteOf, routeOf } from './trade-plan';

export type Filter = Recommendation | 'ALL';
/** Melyik lista látszik: a history-elemzés hosszabb távú lehetőségei, vagy az azonnali üzletek. */
export type View = 'analysis' | 'deals';
export type RouteFilter = RouteKey | 'ALL';
export type DealFilter = 'BUY' | 'ALL';
/**
 * Hogyan teljesül az üzlet: azonnali csere (megveszed egy meglévő ajánlatból, és azonnal eladod egy meglévő buy
 * ordernek), vagy saját buy orderrel (várni kell, amíg valaki eladja neked).
 */
export type ExecutionFilter = 'ALL' | 'INSTANT' | 'ORDER';

/** Az üzlettípusok, amelyeknél mindkét láb azonnal teljesül. */
export const INSTANT_DEAL_TYPES: DealType[] = ['MANNCO_TO_BPTF', 'BPTF_TO_MANNCO_ORDER'];
export const isInstantDeal = (deal: Deal) => INSTANT_DEAL_TYPES.includes(deal.type);

const ROUTES: RouteKey[] = ['bptf>bptf', 'mannco>bptf', 'bptf>mannco'];
const emptyRouteCounts = (): Record<RouteFilter, number> => ({ ALL: 0, 'bptf>bptf': 0, 'mannco>bptf': 0, 'bptf>mannco': 0 });

/** Végtelen görgetés: egyszerre ennyi kártya kerül a lapra, a többi görgetéskor töltődik. */
const PAGE_SIZE = 30;

const POLL_MS = 30_000;
const POLL_WHILE_RUNNING_MS = 3_000;
/** Hiba után hamar újrapróbáljuk, hogy egy épp újrainduló szerver ne tűnjön fél percig elérhetetlennek. */
const POLL_AFTER_ERROR_MS = 3_000;

const errorMessage = (error: unknown) =>
  error instanceof HttpErrorResponse
    ? (error.error?.error ?? (error.status === 0 ? 'A szerver nem érhető el.' : error.message))
    : String(error);

/** A piac elemzett tárgyai signalokban; a szervert rendszeresen lekérdezi. A lista a szerver szerinti, haszon szerint csökkenő sorrendben van. */
@Injectable({ providedIn: 'root' })
export class MarketStore {
  private readonly api = inject(ApiService);
  private readonly snackBar = inject(MatSnackBar);
  private pollTimer?: ReturnType<typeof setTimeout>;

  readonly items = signal<MarketItem[]>([]);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly analyzedAt = signal<string | null>(null);
  readonly keyPriceMetal = signal<number | null>(null);
  readonly screen = signal<ScreenSummary | null>(null);
  readonly collectorRunning = signal(false);
  readonly discordConfigured = signal(false);
  readonly notifyAllBuys = signal(false);
  readonly mannco = signal<MarketResponse['mannco'] | null>(null);
  readonly filter = signal<Filter>('BUY');

  readonly view = signal<View>('analysis');
  /** Hol veszed → hol adod el; mindkét nézetre érvényes. */
  readonly routeFilter = signal<RouteFilter>('ALL');
  readonly dealFilter = signal<DealFilter>('BUY');
  readonly executionFilter = signal<ExecutionFilter>('ALL');

  /** Rendezés nézetenként (a böngésző megjegyzi). */
  readonly itemSort = signal<SortState>(loadSort('analysis', { id: 'profit', dir: 'desc' }));
  readonly dealSort = signal<SortState>(loadSort('deals', { id: 'profit', dir: 'desc' }));
  readonly itemSorts = ITEM_SORTS;

  /** Hány kártya látszik most (végtelen görgetés); szűrő-, rendezés- és nézetváltáskor visszaáll. */
  readonly itemLimit = signal(PAGE_SIZE);
  readonly dealLimit = signal(PAGE_SIZE);
  readonly dealSorts = DEAL_SORTS;
  readonly deals = signal<Deal[]>([]);
  readonly dealLabels = signal<Record<DealType, string> | null>(null);
  readonly dealsGeneratedAt = signal<string | null>(null);
  readonly dealsCoverage = signal<{ matched: number; bidsFresh: number } | null>(null);

  /** A szerveren mentett ár- és típusszűrő. Csak valódi változáskor frissül, hogy a lekérdezések ne írják felül a szerkesztett űrlapot. */
  readonly marketFilter = signal<MarketFilter>(
    { minKeys: null, maxKeys: null, qualities: [] },
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  readonly qualityOptions = signal<QualityOption[]>([], { equal: (a, b) => a.length === b.length });
  readonly hiddenByFilter = signal(0);
  readonly filterPending = signal(false);

  readonly notifiedSkus = computed(() => new Set(this.items().filter((i) => i.notify).map((i) => i.sku)));

  /** A szűrt ajánlású tárgyak útvonalanként (a legjobb útvonal szerint) – a nézet útvonal-szűrőjének számai. */
  readonly itemRouteCounts = computed(() => {
    const counts = emptyRouteCounts();
    for (const item of this.itemsByRecommendation()) {
      const route = bestRouteOf(item);
      if (!route) continue;
      counts.ALL++;
      counts[route]++;
    }
    return counts;
  });

  readonly dealRouteCounts = computed(() => {
    const counts = emptyRouteCounts();
    for (const deal of this.dealsByRecommendation()) {
      counts.ALL++;
      counts[routeOf(deal.buy.market, deal.sell.market)]++;
    }
    return counts;
  });

  readonly routeCounts = computed(() => (this.view() === 'deals' ? this.dealRouteCounts() : this.itemRouteCounts()));
  readonly routes = ROUTES;

  readonly dealCounts = computed(() => ({
    ALL: this.dealsByExecution().length,
    BUY: this.dealsByExecution().filter((d) => d.recommendation === 'BUY').length,
  }));

  /** Az ajánlás szerint szűrt üzletek száma végrehajtás szerint (a végrehajtás-szűrő számai). */
  readonly executionCounts = computed(() => {
    const deals = this.dealFilter() === 'ALL' ? this.deals() : this.deals().filter((d) => d.recommendation === 'BUY');
    const instant = deals.filter(isInstantDeal).length;
    return { ALL: deals.length, INSTANT: instant, ORDER: deals.length - instant };
  });

  private readonly dealsByExecution = computed(() => {
    const execution = this.executionFilter();
    return execution === 'ALL' ? this.deals() : this.deals().filter((d) => isInstantDeal(d) === (execution === 'INSTANT'));
  });

  readonly visibleDeals = computed(() => {
    const route = this.routeFilter();
    const deals = this.dealsByRecommendation().filter((d) => route === 'ALL' || routeOf(d.buy.market, d.sell.market) === route);
    return sortList(deals, DEAL_SORTS, this.dealSort());
  });

  private readonly dealsByRecommendation = computed(() =>
    this.dealFilter() === 'ALL' ? this.dealsByExecution() : this.dealsByExecution().filter((d) => d.recommendation === 'BUY'));

  private readonly itemsByRecommendation = computed(() => {
    const filter = this.filter();
    return filter === 'ALL' ? this.items() : this.items().filter((i) => i.analysis && bestRecommendation(i.analysis) === filter);
  });

  readonly counts = computed(() => {
    const counts: Record<Filter, number> = { ALL: 0, BUY: 0, WATCH: 0, INSUFFICIENT_DATA: 0, AVOID: 0 };
    for (const item of this.items()) {
      counts.ALL++;
      if (item.analysis) counts[bestRecommendation(item.analysis)]++;
    }
    return counts;
  });

  readonly visibleItems = computed(() => {
    const route = this.routeFilter();
    const items = this.itemsByRecommendation().filter((i) => route === 'ALL' || bestRouteOf(i) === route);
    return sortList(items, ITEM_SORTS, this.itemSort());
  });

  /** A ténylegesen megjelenített kártyák (a szűrt, rendezett lista eleje). */
  readonly shownItems = computed(() => this.visibleItems().slice(0, this.itemLimit()));
  readonly shownDeals = computed(() => this.visibleDeals().slice(0, this.dealLimit()));

  constructor() {
    // Más szűrés vagy rendezés esetén a lista elejéről indulunk; az adatfrissítés (lekérdezés) nem állítja vissza
    effect(() => {
      this.view(); this.filter(); this.routeFilter(); this.itemSort(); this.marketFilter();
      untracked(() => this.itemLimit.set(PAGE_SIZE));
    });
    effect(() => {
      this.view(); this.dealFilter(); this.executionFilter(); this.routeFilter(); this.dealSort(); this.marketFilter();
      untracked(() => this.dealLimit.set(PAGE_SIZE));
    });
    void this.refresh();
    inject(DestroyRef).onDestroy(() => clearTimeout(this.pollTimer));
  }

  async refresh() {
    void this.refreshDeals();
    try {
      const data = await firstValueFrom(this.api.getMarket());
      this.items.set(data.items);
      this.analyzedAt.set(data.analyzedAt);
      this.keyPriceMetal.set(data.keyPriceMetal);
      this.screen.set(data.screen);
      this.collectorRunning.set(data.collector.running);
      this.discordConfigured.set(data.discord.configured);
      this.notifyAllBuys.set(data.notifications.notifyAllBuys);
      this.mannco.set(data.mannco);
      this.marketFilter.set(data.filter);
      this.qualityOptions.set(data.qualities);
      this.hiddenByFilter.set(data.hiddenByFilter);
      this.filterPending.set(data.filterPending);
      this.error.set(null);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loaded.set(true);
      this.schedulePoll();
    }
  }

  /** Az azonnali üzletek; a hibájuk nem akasztja meg a fő listát (pl. ha a mannco nincs beállítva). */
  private async refreshDeals() {
    try {
      const data = await firstValueFrom(this.api.getDeals());
      this.deals.set(data.deals);
      this.dealLabels.set(data.labels);
      this.dealsGeneratedAt.set(data.generatedAt);
      this.dealsCoverage.set(data.coverage);
    } catch {
      // A fő lista hibája (lent) már jelzi, ha a szerver nem érhető el
    }
  }

  async setNotify(item: Pick<MarketItem, 'sku' | 'name'>, notify: boolean) {
    // Optimista frissítés; hiba esetén visszaállítjuk
    const previous = this.items().find((i) => i.sku === item.sku)?.notify
      ?? this.deals().find((d) => d.sku === item.sku)?.notify;
    this.patchItem(item.sku, { notify });
    try {
      await firstValueFrom(this.api.setItemNotify(item.sku, notify));
      if (previous === undefined) {
        this.notify(`${item.name}: értesítés bekapcsolva – az elemzése hamarosan elkészül.`);
        await this.refresh();
      }
    } catch (error) {
      if (previous !== undefined) this.patchItem(item.sku, { notify: previous });
      this.notify(errorMessage(error));
    }
  }

  /** A következő adag kártya megjelenítése (ha van még). */
  loadMore(view: View) {
    const [limit, total] = view === 'deals'
      ? [this.dealLimit, this.visibleDeals().length]
      : [this.itemLimit, this.visibleItems().length];
    if (limit() < total) limit.update((n) => n + PAGE_SIZE);
  }

  /** Rendezés választása: az új szempont a saját alapirányával indul. */
  setSort(view: View, id: string) {
    const options = view === 'deals' ? DEAL_SORTS : ITEM_SORTS;
    const option = options.find((o) => o.id === id) ?? options[0];
    this.updateSort(view, { id: option.id, dir: option.dir });
  }

  toggleSortDir(view: View) {
    const current = view === 'deals' ? this.dealSort() : this.itemSort();
    this.updateSort(view, { ...current, dir: current.dir === 'asc' ? 'desc' : 'asc' });
  }

  private updateSort(view: View, state: SortState) {
    (view === 'deals' ? this.dealSort : this.itemSort).set(state);
    saveSort(view, state);
  }

  /** Keresésből: értesítés kérése egy tárgyra, amely így a listára is felkerül. */
  watch(item: ItemSearchResult) {
    return this.setNotify(item, true);
  }

  async setNotifyAllBuys(notifyAllBuys: boolean) {
    this.notifyAllBuys.set(notifyAllBuys);
    try {
      await firstValueFrom(this.api.setNotifyAllBuys(notifyAllBuys));
      // A tárgyankénti értékek a beállítástól függnek, ezért újratöltjük
      await this.refresh();
    } catch (error) {
      this.notifyAllBuys.set(!notifyAllBuys);
      this.notify(errorMessage(error));
    }
  }

  /** Az új szűrővel az előszűrés újra lefut, és a megfelelő tárgyak közül választ jelölteket. */
  async applyFilter(filter: MarketFilter) {
    try {
      await firstValueFrom(this.api.setFilter(filter));
      this.notify('Szűrő mentve – az új jelöltek elemzése elindult, ez néhány percig tarthat.');
      await this.refresh();
    } catch (error) {
      this.notify(errorMessage(error));
    }
  }

  async runCollector() {
    try {
      await firstValueFrom(this.api.runCollector());
      this.collectorRunning.set(true);
      this.notify('A gyűjtés elindult.');
      this.schedulePoll();
    } catch (error) {
      this.notify(errorMessage(error));
    }
  }

  async testNotification() {
    try {
      const { message } = await firstValueFrom(this.api.testNotification());
      this.notify(message);
    } catch (error) {
      this.notify(errorMessage(error));
    }
  }

  private patchItem(sku: string, changes: Pick<MarketItem, 'notify'>) {
    this.items.update((items) => items.map((i) => (i.sku === sku ? { ...i, ...changes } : i)));
    this.deals.update((deals) => deals.map((d) => (d.sku === sku ? { ...d, ...changes } : d)));
  }

  private schedulePoll() {
    clearTimeout(this.pollTimer);
    const delay = this.error() ? POLL_AFTER_ERROR_MS : this.collectorRunning() ? POLL_WHILE_RUNNING_MS : POLL_MS;
    this.pollTimer = setTimeout(() => void this.refresh(), delay);
  }

  private notify(message: string) {
    this.snackBar.open(message, 'OK', { duration: 5000 });
  }
}
