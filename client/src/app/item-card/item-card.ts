import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  RECOMMENDATION_ICONS,
  RECOMMENDATION_LABELS,
  RISK_LABELS,
  bestRecommendation,
  formatKeys,
  formatMoney,
  formatPercent,
  formatUsd,
  timeAgo,
} from '../core/format';
import { MarketItem } from '../core/models';
import { analysisPlans } from '../core/trade-plan';
import { ItemStats, ItemStatsDialogData } from '../item-stats/item-stats';
import { TradeRoute } from '../trade-route/trade-route';

const CHECK_CATEGORY_LABELS = { data: 'Adat', profit: 'Haszon', risk: 'Kockázat' } as const;

@Component({
  selector: 'app-item-card',
  imports: [MatButtonModule, MatCardModule, MatExpansionModule, MatIconModule, MatSlideToggleModule, MatTooltipModule, TradeRoute],
  templateUrl: './item-card.html',
  styleUrl: './item-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemCard {
  readonly item = input.required<MarketItem>();
  readonly collectorRunning = input(false);

  readonly notifyChange = output<boolean>();
  readonly remove = output<void>();

  protected readonly analysis = computed(() => this.item().analysis);
  protected readonly failedChecks = computed(() => this.analysis()?.checks.filter((c) => !c.passed).length ?? 0);
  protected readonly alternative = computed(() => this.analysis()?.alternative ?? null);
  protected readonly failedAlternativeChecks = computed(() => this.alternative()?.checks.filter((c) => !c.passed).length ?? 0);
  /** A kártya jelvénye és színe a legjobb vételi útvonal ajánlását mutatja. */
  protected readonly recommendation = computed(() => {
    const a = this.analysis();
    return a ? bestRecommendation(a) : null;
  });
  protected readonly bestIsMannco = computed(() => this.analysis()?.bestRoute?.source === 'mannco');
  /** Hol vedd, hol add el: a legjobb útvonal elöl. */
  protected readonly plans = computed(() => analysisPlans(this.item()));

  private readonly dialog = inject(MatDialog);

  /** A tárgy statisztikái: milyen adatok alapján döntött az elemzés. */
  protected openStats() {
    this.dialog.open<ItemStats, ItemStatsDialogData>(ItemStats, {
      data: { sku: this.item().sku, name: this.item().name, bptfUrl: this.item().bptfUrl, manncoUrl: this.analysis()?.alternative?.url ?? null },
      width: '1100px',
      maxWidth: '96vw',
      autoFocus: false,
    });
  }

  protected readonly recommendationLabels = RECOMMENDATION_LABELS;
  protected readonly recommendationIcons = RECOMMENDATION_ICONS;
  protected readonly riskLabels = RISK_LABELS;
  protected readonly categoryLabels = CHECK_CATEGORY_LABELS;
  protected readonly formatMoney = formatMoney;
  protected readonly formatKeys = formatKeys;
  protected readonly formatPercent = formatPercent;
  protected readonly formatUsd = formatUsd;
  protected readonly timeAgo = timeAgo;
}
