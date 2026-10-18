import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { firstValueFrom } from 'rxjs';
import { Bar, BarChart } from '../charts/bar-chart';
import { formatDateLong, formatNumber, niceTicks } from '../charts/chart-utils';
import { CheckBars } from '../charts/check-bars';
import { LineChart, LineSeries, RefLine } from '../charts/line-chart';
import { ApiService } from '../core/api.service';
import { RECOMMENDATION_LABELS, formatKeys, formatPercent, formatUsd } from '../core/format';
import { ItemStats as ItemStatsData } from '../core/models';

export interface ItemStatsDialogData {
  sku: string;
  name: string;
  bptfUrl?: string | null;
  manncoUrl?: string | null;
}

type Route = 'bptf' | 'mannco';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/**
 * Egy tárgy statisztikái: milyen adatok alapján döntött az elemzés. Ártörténet a döntési szintekkel, a tényleges
 * mannco eladások heti bontásban, a visszateszt hozamainak eloszlása, és minden szabály értéke a küszöbhöz képest.
 * A mannco útvonalnál (vétel mannco-n, eladás bptf-en) a szintek, a hozamok és a szabályok a mannco árral számolnak.
 */
@Component({
  selector: 'app-item-stats',
  imports: [
    BarChart,
    CheckBars,
    LineChart,
    MatButtonModule,
    MatButtonToggleModule,
    MatDialogModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './item-stats.html',
  styleUrl: './item-stats.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemStats {
  protected readonly data = inject<ItemStatsDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(ApiService);

  protected readonly stats = signal<ItemStatsData | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly route = signal<Route>('bptf');

  protected readonly recommendationLabels = RECOMMENDATION_LABELS;
  protected readonly formatKeys = formatKeys;
  protected readonly formatPercent = formatPercent;
  protected readonly formatUsd = formatUsd;
  protected readonly dateLong = formatDateLong;
  protected readonly num = (v: number, d = 2) => formatNumber(v, d);

  constructor() {
    void this.load();
  }

  private async load() {
    try {
      const stats = await firstValueFrom(this.api.getItemStats(this.data.sku));
      this.stats.set(stats);
      if (stats.analysis.bestRoute?.source === 'mannco' && stats.analysis.alternative) this.route.set('mannco');
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse && error.status === 404
          ? 'Ehhez a tárgyhoz még nincs letöltött backpack.tf history, ezért nincs elemzés. (Akkor lesz, ha bekerül a jelöltek közé, vagy értesítést kérsz rá.)'
          : 'A statisztika nem tölthető be. Fut a szerver?',
      );
    }
  }

  protected readonly analysis = computed(() => this.stats()?.analysis ?? null);
  protected readonly alternative = computed(() => this.analysis()?.alternative ?? null);
  protected readonly isMannco = computed(() => this.route() === 'mannco' && !!this.alternative());

  /** A kiválasztott útvonal összesítője. */
  protected readonly summary = computed(() => {
    const a = this.analysis();
    if (!a) return null;
    const m = this.isMannco() ? this.alternative() : null;
    return {
      recommendation: m ? m.recommendation : a.recommendation,
      summary: m ? m.summary : a.summary,
      profitKeys: m ? m.profit.conservativeProfitKeys : a.profit.conservativeProfitKeys,
      marginPercent: m ? m.profit.conservativeMarginPercent : a.profit.conservativeMarginPercent,
      winRate: m ? m.risk.backtestWinRatePercent : a.risk.backtestWinRatePercent,
      trades: m ? m.risk.backtestIndependentTrades : a.risk.backtestIndependentTrades,
      checks: m ? m.checks : a.checks,
    };
  });

  /** Ártörténet: a bptf vétel és eladás lépcsős vonalként (kiugrók nélkül), a mannco eladások pontként. */
  protected readonly priceSeries = computed<LineSeries[]>(() => {
    const s = this.stats();
    if (!s) return [];
    const clean = s.analysis.series.points.filter((p) => !p[3]);
    const series: LineSeries[] = [
      { id: 'buy', label: 'backpack.tf vétel (buy order)', color: 'var(--chart-1)', kind: 'step', points: clean.map((p) => ({ t: p[0] * 1000, v: p[1] })) },
      { id: 'sell', label: 'backpack.tf eladás (hirdetés)', color: 'var(--chart-2)', kind: 'step', points: clean.map((p) => ({ t: p[0] * 1000, v: p[2] })) },
    ];
    const sales = (s.mannco?.sales ?? []).filter((d) => d[3] !== null && d[0] >= s.analysis.series.backtestStart * 1000);
    if (sales.length > 0) {
      series.push({
        id: 'mannco',
        label: 'mannco tényleges eladás (napi átlagár)',
        color: 'var(--chart-3)',
        kind: 'dots',
        points: sales.map((d) => ({ t: d[0], v: d[3]! })),
        notes: sales.map((d) => `${d[1]} db · ${formatUsd(d[2])}`),
      });
    }
    return series;
  });

  /** A döntési szintek a kiválasztott útvonalon. */
  protected readonly refLines = computed<RefLine[]>(() => {
    const a = this.analysis();
    if (!a) return [];
    const m = this.isMannco() ? this.alternative() : null;
    return [
      m ? { label: 'mannco ár', value: m.buyKeys } : { label: 'Max. vétel', value: a.prices.maxBuyPriceKeys },
      { label: 'Javasolt eladás', value: a.prices.targetSellKeys },
      { label: 'Óvatos eladás (nettó)', value: (a.prices as { conservativeSellNetKeys?: number }).conservativeSellNetKeys ?? NaN },
    ];
  });

  protected readonly outliers = computed(() => this.stats()?.analysis.series.points.filter((p) => p[3]).length ?? 0);

  /** A mannco eladások heti bontásban az elmúlt 52 hétben. */
  protected readonly weeklySales = computed(() => {
    const s = this.stats();
    const sales = s?.mannco?.sales ?? [];
    const end = Math.floor(Date.now() / DAY) * DAY + DAY;
    const weeks = Array.from({ length: 52 }, (_, i) => ({ start: end - (52 - i) * WEEK, count: 0, usd: 0, keys: 0 }));
    for (const [t, count, unitUsd, unitKeys] of sales) {
      const i = Math.floor((t - weeks[0].start) / WEEK);
      if (i < 0 || i >= weeks.length) continue;
      weeks[i].count += count;
      weeks[i].usd += unitUsd * count;
      weeks[i].keys += (unitKeys ?? 0) * count;
    }
    return weeks;
  });

  protected readonly salesBars = computed<Bar[]>(() =>
    this.weeklySales().map((w) => ({
      label: new Date(w.start).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' }),
      value: w.count,
      color: 'var(--chart-1)',
      tooltip: [
        `${w.count} db eladva`,
        `${formatDateLong(w.start)} – ${formatDateLong(w.start + WEEK - DAY)}`,
        ...(w.count > 0 ? [`átlagár ${formatUsd(w.usd / w.count)} ≈ ${formatKeys(w.keys / w.count)}`] : []),
      ],
    })));

  protected readonly salesTotals = computed(() => {
    const a = this.analysis();
    return a?.sales ?? null;
  });

  /** A visszateszt hozamainak eloszlása (a kiválasztott útvonalon), kerek határú sávokban. */
  protected readonly returnBins = computed(() => {
    const s = this.stats();
    const returns = (this.isMannco() ? s?.analysis.series.alternativeReturns : s?.analysis.series.backtestReturns) ?? [];
    if (returns.length === 0) return { bars: [] as Bar[], zeroIndex: null as number | null };
    const min = Math.min(...returns, 0);
    const max = Math.max(...returns, 0);
    const ticks = niceTicks(min, max, 20);
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    const start = Math.floor(min / step) * step;
    const count = Math.max(1, Math.ceil((max - start) / step + 1e-9));
    const bins = Array.from({ length: count }, (_, i) => ({ from: start + i * step, n: 0 }));
    for (const r of returns) bins[Math.min(count - 1, Math.max(0, Math.floor((r - start) / step)))].n++;
    const total = returns.length;
    return {
      zeroIndex: (0 - start) / step,
      bars: bins.map((b) => ({
        label: `${formatNumber(b.from, 1)}%`,
        value: b.n,
        color: b.from + step <= 0 ? 'var(--chart-negative)' : 'var(--chart-positive)',
        tooltip: [
          `${b.n} eset (${formatNumber((b.n / total) * 100, 1)}%)`,
          `hozam ${formatNumber(b.from, 1)}% – ${formatNumber(b.from + step, 1)}%`,
        ],
      })),
    };
  });

  /** Táblázatos nézet: a legutóbbi árbejegyzések (legújabb elöl). */
  protected readonly priceRows = computed(() =>
    (this.stats()?.analysis.series.points ?? []).slice().reverse().slice(0, 40)
      .map(([t, buy, sell, outlier]) => ({ t: t * 1000, buy, sell, outlier })));

  protected readonly salesRows = computed(() =>
    (this.stats()?.mannco?.sales ?? []).slice().reverse().slice(0, 40)
      .map(([t, count, usd, keys]) => ({ t, count, usd, keys })));
}
