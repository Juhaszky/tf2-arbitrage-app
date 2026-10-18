import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { formatKeys, formatUsd } from '../core/format';
import { Deal } from '../core/models';
import { isInstantDeal } from '../core/market.store';
import { dealPlan } from '../core/trade-plan';
import { ItemStats, ItemStatsDialogData } from '../item-stats/item-stats';
import { TradeRoute } from '../trade-route/trade-route';

const CHECK_CATEGORY_LABELS = { data: 'Adat', profit: 'Haszon', risk: 'Kockázat' } as const;

/** Egy azonnali üzlet: hol veszed, hol adod el, mennyi a haszon, és mely ellenőrzések teljesültek. */
@Component({
  selector: 'app-deal-card',
  imports: [MatButtonModule, MatCardModule, MatExpansionModule, MatIconModule, MatSlideToggleModule, MatTooltipModule, TradeRoute],
  templateUrl: './deal-card.html',
  styleUrl: './deal-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DealCard {
  readonly deal = input.required<Deal>();
  /** Az üzlettípus megnevezése (a szervertől). */
  readonly label = input('');

  readonly notifyChange = output<boolean>();

  protected readonly plan = computed(() => dealPlan(this.deal()));
  /** Mindkét láb azonnal teljesül (meglévő ajánlatból veszed, meglévő buy ordernek adod el). */
  protected readonly instant = computed(() => isInstantDeal(this.deal()));
  protected readonly failedChecks = computed(() => this.deal().checks.filter((c) => !c.passed));

  private readonly dialog = inject(MatDialog);

  /** A tárgy statisztikái: milyen adatok alapján döntött az elemzés. */
  protected openStats() {
    this.dialog.open<ItemStats, ItemStatsDialogData>(ItemStats, {
      data: { sku: this.deal().sku, name: this.deal().name, bptfUrl: this.deal().bptfUrl, manncoUrl: this.deal().manncoUrl },
      width: '1100px',
      maxWidth: '96vw',
      autoFocus: false,
    });
  }

  protected readonly categoryLabels = CHECK_CATEGORY_LABELS;
  protected readonly formatKeys = formatKeys;
  protected readonly formatUsd = formatUsd;
}
