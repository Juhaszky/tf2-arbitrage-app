import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Check } from '../core/models';
import { formatNumber } from './chart-utils';

/** A szabályok neve, mértékegysége és iránya (`max`: a küszöb felső korlát, különben alsó). */
const RULES: Record<string, { label: string; unit: string; max?: boolean }> = {
  DATA_POINTS: { label: 'Árbejegyzések a visszateszt időszakában', unit: 'db' },
  HISTORY_SPAN: { label: 'A history hossza', unit: 'nap' },
  FRESHNESS: { label: 'A legutolsó ár kora', unit: 'óra', max: true },
  BACKTEST_SAMPLE: { label: 'Független visszatesztelt ügyletek', unit: 'db' },
  CONSERVATIVE_MARGIN: { label: 'Óvatos haszonkulcs', unit: '%' },
  CONSERVATIVE_PROFIT: { label: 'Óvatos haszon', unit: 'kulcs' },
  WIN_RATE: { label: 'Nyerési arány a visszatesztben', unit: '%' },
  WIN_RATE_CONFIDENCE: { label: 'Nyerési arány 90%-os biztonsággal', unit: '%' },
  VOLATILITY: { label: 'Az eladási ár ingadozása', unit: '%', max: true },
  TREND: { label: 'Az eladási ár heti változása', unit: '%' },
  LIQUIDITY: { label: 'Árváltozások naponta', unit: '/nap' },
  SPREAD_SANITY: { label: 'Árrés (eladás a vétel fölött)', unit: '%', max: true },
  SALE_SPEED: { label: 'Becsült eladási idő (mannco eladások)', unit: 'nap', max: true },
  STOCK: { label: 'Elérhető darab a mannco-n', unit: 'db' },
  PRICE_SANITY: { label: 'mannco ár a bptf medián vételi ár %-ában', unit: '%' },
};

const CATEGORY_LABELS: Record<Check['category'], string> = { data: 'Adat', profit: 'Haszon', risk: 'Kockázat' };

/**
 * A szabályok mért értéke a küszöbhöz képest, soronként saját skálán: a sáv az érték, a függőleges jelölő a küszöb.
 * Az állapotot ikon és szöveg is jelzi, nem csak a szín. A nagyon kilógó értékek (pl. „sosem kelt el”) a skála végén
 * nyíllal jelennek meg.
 */
@Component({
  selector: 'app-check-bars',
  imports: [MatIconModule],
  template: `
    <ul class="rows">
      @for (row of rows(); track row.id) {
        <li [class.failed]="!row.passed">
          <div class="head">
            <mat-icon aria-hidden="true">{{ row.passed ? 'check_circle' : 'cancel' }}</mat-icon>
            <span class="status">{{ row.passed ? 'Teljesült' : 'Nem teljesült' }}</span>
            <span class="name">{{ row.label }}</span>
            <span class="category">{{ row.category }}</span>
            <span class="values">
              <strong>{{ row.valueText }}</strong> · küszöb {{ row.max ? '≤' : '≥' }} {{ row.thresholdText }}
            </span>
          </div>
          <div class="track" aria-hidden="true">
            <div class="fill" [style.left.%]="row.fillLeft" [style.width.%]="row.fillWidth"></div>
            @if (row.overflow) {
              <mat-icon class="overflow">arrow_right</mat-icon>
            }
            <div class="threshold" [style.left.%]="row.thresholdPos"></div>
            @if (row.zeroPos > 0 && row.zeroPos < 100) {
              <div class="zero" [style.left.%]="row.zeroPos"></div>
            }
          </div>
          <p class="message">{{ row.message }}</p>
        </li>
      }
    </ul>
  `,
  styles: `
    :host { display: block; }
    .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
    .head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font: var(--mat-sys-body-medium); }
    .head mat-icon { font-size: 18px; width: 18px; height: 18px; color: var(--chart-good); }
    li.failed .head mat-icon { color: var(--chart-critical); }
    .status { font: var(--mat-sys-label-medium); color: var(--mat-sys-on-surface-variant); }
    li.failed .status { color: var(--mat-sys-on-surface); }
    .name { font: var(--mat-sys-title-small); }
    .category { font: var(--mat-sys-label-small); color: var(--mat-sys-on-surface-variant); }
    .values { margin-left: auto; color: var(--mat-sys-on-surface-variant); font-variant-numeric: tabular-nums; }
    .values strong { color: var(--mat-sys-on-surface); }
    .track { position: relative; height: 10px; margin: 6px 0 4px; border-radius: 4px; background: var(--mat-sys-surface-container-high); }
    .fill { position: absolute; top: 0; bottom: 0; border-radius: 4px; background: var(--chart-good); }
    li.failed .fill { background: var(--chart-critical); }
    .threshold { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--mat-sys-on-surface); border-radius: 1px; }
    .zero { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--mat-sys-on-surface-variant); }
    .overflow { position: absolute; right: -6px; top: -7px; font-size: 24px; width: 24px; height: 24px; color: var(--chart-critical); }
    .message { margin: 0; font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CheckBars {
  readonly checks = input.required<Check[]>();

  protected readonly rows = computed(() =>
    this.checks().map((c) => {
      const rule = RULES[c.id] ?? { label: c.id, unit: '' };
      const threshold = c.threshold;
      // A skála a 0-tól a küszöb és az érték nagyobbikáig tart; a nagyon kilógó érték a küszöb háromszorosánál megáll
      const cap = Math.abs(threshold) * 3 || Math.abs(c.value) || 1;
      const shown = Math.max(Math.min(c.value, cap), -cap);
      const lo = Math.min(0, shown, threshold);
      const hi = Math.max(0, shown, threshold) * 1.15 || 1;
      const pos = (v: number) => ((v - lo) / (hi - lo)) * 100;
      const zero = pos(0);
      const fmt = (v: number) => `${formatNumber(v, Math.abs(v) < 10 ? 2 : 1)}${rule.unit === '%' ? '%' : ` ${rule.unit}`}`;
      return {
        id: c.id,
        label: rule.label,
        max: !!rule.max,
        category: CATEGORY_LABELS[c.category],
        passed: c.passed,
        message: c.message,
        valueText: c.value >= 9999 ? 'nincs eladás' : fmt(c.value),
        thresholdText: fmt(threshold),
        fillLeft: Math.min(zero, pos(shown)),
        fillWidth: Math.abs(pos(shown) - zero),
        thresholdPos: pos(threshold),
        zeroPos: zero,
        overflow: Math.abs(c.value) > cap,
      };
    }));
}
