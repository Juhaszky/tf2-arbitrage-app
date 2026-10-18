import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MarketStore } from '../core/market.store';
import { MarketFilter } from '../core/models';

const EMPTY: MarketFilter = { minKeys: null, maxKeys: null, qualities: [] };

const parseKeys = (value: string): number | null => {
  const n = parseFloat(value.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Vételi ár (kulcs) és típus szerinti szűrő. A szűrő a szerveren az előszűrést is szűkíti (a teljes elemzés
 * csak a megfelelő tárgyakra fut), ezért nem minden billentyűleütésre, hanem az Alkalmaz gombra mentjük.
 */
@Component({
  selector: 'app-market-filter',
  imports: [MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatIconModule, MatInputModule],
  templateUrl: './market-filter.html',
  styleUrl: './market-filter.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarketFilterPanel {
  protected readonly store = inject(MarketStore);

  /** Az űrlap állapota; a szerveren mentett szűrő változásakor újraindul. */
  protected readonly draft = linkedSignal(() => this.store.marketFilter());

  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(this.store.marketFilter()));
  protected readonly invalid = computed(() => {
    const { minKeys, maxKeys } = this.draft();
    return minKeys !== null && maxKeys !== null && minKeys > maxKeys;
  });
  protected readonly active = computed(() => JSON.stringify(this.store.marketFilter()) !== JSON.stringify(EMPTY));

  protected setMin(event: Event) {
    this.draft.update((f) => ({ ...f, minKeys: parseKeys((event.target as HTMLInputElement).value) }));
  }

  protected setMax(event: Event) {
    this.draft.update((f) => ({ ...f, maxKeys: parseKeys((event.target as HTMLInputElement).value) }));
  }

  protected setQualities(qualities: string[] | null) {
    this.draft.update((f) => ({ ...f, qualities: qualities ?? [] }));
  }

  protected apply() {
    if (!this.invalid()) void this.store.applyFilter(this.draft());
  }

  protected clear() {
    if (this.active()) void this.store.applyFilter(EMPTY);
    else this.draft.set(EMPTY);
  }
}
