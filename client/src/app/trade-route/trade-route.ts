import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RECOMMENDATION_LABELS, formatKeys, formatPercent } from '../core/format';
import { TradePlan } from '../core/models';
import { MARKET_LABELS } from '../core/trade-plan';

/** Kereskedési útvonal: hol veszed (hol olcsó) → hol adod el, piaconként saját színnel, a haszonnal. */
@Component({
  selector: 'app-trade-route',
  imports: [MatIconModule],
  templateUrl: './trade-route.html',
  styleUrl: './trade-route.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TradeRoute {
  readonly plan = input.required<TradePlan>();
  /** Halványabb megjelenés a másodlagos (nem legjobb) útvonalhoz. */
  readonly secondary = input(false);

  protected readonly marketLabels = MARKET_LABELS;
  protected readonly recommendationLabels = RECOMMENDATION_LABELS;
  protected readonly formatKeys = formatKeys;
  protected readonly formatPercent = formatPercent;
}
