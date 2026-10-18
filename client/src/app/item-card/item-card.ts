import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
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
  formatKeys,
  formatMoney,
  formatPercent,
  timeAgo,
} from '../core/format';
import { TrackedItem } from '../core/models';

const CHECK_CATEGORY_LABELS = { data: 'Adat', profit: 'Haszon', risk: 'Kockázat' } as const;

@Component({
  selector: 'app-item-card',
  imports: [MatButtonModule, MatCardModule, MatExpansionModule, MatIconModule, MatSlideToggleModule, MatTooltipModule],
  templateUrl: './item-card.html',
  styleUrl: './item-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemCard {
  readonly item = input.required<TrackedItem>();
  readonly collectorRunning = input(false);

  readonly notifyChange = output<boolean>();
  readonly remove = output<void>();

  protected readonly analysis = computed(() => this.item().analysis);
  protected readonly failedChecks = computed(() => this.analysis()?.checks.filter((c) => !c.passed).length ?? 0);

  protected readonly recommendationLabels = RECOMMENDATION_LABELS;
  protected readonly recommendationIcons = RECOMMENDATION_ICONS;
  protected readonly riskLabels = RISK_LABELS;
  protected readonly categoryLabels = CHECK_CATEGORY_LABELS;
  protected readonly formatMoney = formatMoney;
  protected readonly formatKeys = formatKeys;
  protected readonly formatPercent = formatPercent;
  protected readonly timeAgo = timeAgo;
}
