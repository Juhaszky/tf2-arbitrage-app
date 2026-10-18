import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { ItemSearchResult, Recommendation, TrackedItem } from './models';

export type Filter = Recommendation | 'ALL';

const POLL_MS = 30_000;
const POLL_WHILE_RUNNING_MS = 3_000;

const errorMessage = (error: unknown) =>
  error instanceof HttpErrorResponse
    ? (error.error?.error ?? (error.status === 0 ? 'A szerver nem érhető el.' : error.message))
    : String(error);

/** A követett tárgyak állapota signalokban; a szervert rendszeresen lekérdezi. */
@Injectable({ providedIn: 'root' })
export class TrackedStore {
  private readonly api = inject(ApiService);
  private readonly snackBar = inject(MatSnackBar);
  private pollTimer?: ReturnType<typeof setTimeout>;

  readonly items = signal<TrackedItem[]>([]);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly analyzedAt = signal<string | null>(null);
  readonly keyPriceMetal = signal<number | null>(null);
  readonly collectorRunning = signal(false);
  readonly discordConfigured = signal(false);
  readonly filter = signal<Filter>('ALL');

  readonly trackedSkus = computed(() => new Set(this.items().map((i) => i.sku)));

  readonly counts = computed(() => {
    const counts: Record<Filter, number> = { ALL: 0, BUY: 0, WATCH: 0, INSUFFICIENT_DATA: 0, AVOID: 0 };
    for (const item of this.items()) {
      counts.ALL++;
      if (item.analysis) counts[item.analysis.recommendation]++;
    }
    return counts;
  });

  readonly visibleItems = computed(() => {
    const filter = this.filter();
    return filter === 'ALL' ? this.items() : this.items().filter((i) => i.analysis?.recommendation === filter);
  });

  constructor() {
    void this.refresh();
    inject(DestroyRef).onDestroy(() => clearTimeout(this.pollTimer));
  }

  async refresh() {
    try {
      const data = await firstValueFrom(this.api.getTracked());
      this.items.set(data.items);
      this.analyzedAt.set(data.analyzedAt);
      this.keyPriceMetal.set(data.keyPriceMetal);
      this.collectorRunning.set(data.collector.running);
      this.discordConfigured.set(data.discord.configured);
      this.error.set(null);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loaded.set(true);
      this.schedulePoll();
    }
  }

  async add(item: ItemSearchResult, notify = true) {
    try {
      await firstValueFrom(this.api.addTracked(item.sku, notify));
      this.notify(`${item.name} hozzáadva – az adatai letöltése elindult.`);
      await this.refresh();
    } catch (error) {
      this.notify(errorMessage(error));
    }
  }

  async setNotify(item: TrackedItem, notify: boolean) {
    // Optimista frissítés; hiba esetén visszaállítjuk
    this.patchItem(item.sku, { notify });
    try {
      await firstValueFrom(this.api.setNotify(item.sku, notify));
    } catch (error) {
      this.patchItem(item.sku, { notify: !notify });
      this.notify(errorMessage(error));
    }
  }

  async remove(item: TrackedItem) {
    try {
      await firstValueFrom(this.api.removeTracked(item.sku));
      this.items.update((items) => items.filter((i) => i.sku !== item.sku));
      const ref = this.snackBar.open(`${item.name} eltávolítva.`, 'Visszavonás', { duration: 6000 });
      ref.onAction().subscribe(() => void this.add({ sku: item.sku, name: item.name }, item.notify));
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

  private patchItem(sku: string, changes: Partial<TrackedItem>) {
    this.items.update((items) => items.map((i) => (i.sku === sku ? { ...i, ...changes } : i)));
  }

  private schedulePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(
      () => void this.refresh(),
      this.collectorRunning() ? POLL_WHILE_RUNNING_MS : POLL_MS,
    );
  }

  private notify(message: string) {
    this.snackBar.open(message, 'OK', { duration: 5000 });
  }
}
