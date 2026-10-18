import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { formatCompact, formatDate, formatDateLong, formatNumber, linear, niceDomain, niceTicks, stepValueAt, timeTicks } from './chart-utils';

export interface ChartPoint {
  /** Idő (ms). */
  t: number;
  v: number;
}

export interface LineSeries {
  id: string;
  label: string;
  /** CSS szín (változó), pl. `var(--chart-1)`. */
  color: string;
  /** `step`: lépcsős vonal (az ár a következő bejegyzésig érvényes); `dots`: pontok (pl. tényleges eladások). */
  kind: 'step' | 'dots';
  points: ChartPoint[];
  /** A pontokhoz tartozó extra szöveg az adatsávban (pl. darabszám). */
  notes?: string[];
}

export interface RefLine {
  label: string;
  value: number;
}

const MARGIN = { top: 12, right: 132, bottom: 28, left: 52 };
const DAY = 86_400_000;

/**
 * Idősor-diagram egyetlen y-tengellyel: lépcsős vonalak és pontsorozatok, vékony, jobb oldalon feliratozott
 * referenciavonalakkal (pl. döntési küszöbök). Egérrel/érintéssel a segédvonal a legközelebbi időpontra áll, és az
 * adatsáv minden sorozat értékét mutatja abban az időpontban.
 */
@Component({
  selector: 'app-line-chart',
  template: `
    @if (series().length > 1) {
      <ul class="legend">
        @for (s of series(); track s.id) {
          <li>
            @if (s.kind === 'step') {
              <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" [attr.stroke]="s.color" stroke-width="2" stroke-linecap="round" /></svg>
            } @else {
              <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="4" [attr.fill]="s.color" /></svg>
            }
            {{ s.label }}
          </li>
        }
      </ul>
    }
    <div class="plot" [style.height.px]="height()">
      @if (width() > 0 && geometry(); as g) {
        <svg [attr.width]="width()" [attr.height]="height()" role="img" [attr.aria-label]="ariaLabel()"
          (pointermove)="onMove($event)" (pointerleave)="hover.set(null)">
          @for (tick of g.yTicks; track tick) {
            <line class="grid" [attr.x1]="g.left" [attr.x2]="g.right" [attr.y1]="g.y(tick)" [attr.y2]="g.y(tick)" />
            <text class="axis" [attr.x]="g.left - 8" [attr.y]="g.y(tick)" text-anchor="end" dominant-baseline="middle">{{ compact(tick) }}</text>
          }
          @for (tick of g.xTicks; track tick) {
            <text class="axis" [attr.x]="g.x(tick)" [attr.y]="height() - 8" text-anchor="middle">{{ date(tick) }}</text>
          }
          @if (g.shade; as sh) {
            <rect class="shade" [attr.x]="g.left" [attr.y]="g.top" [attr.width]="sh" [attr.height]="g.bottom - g.top" />
          }

          @for (ref of g.refs; track ref.label) {
            <line class="ref" [attr.x1]="g.left" [attr.x2]="g.right" [attr.y1]="ref.y" [attr.y2]="ref.y" />
            <text class="ref-label" [attr.x]="g.right + 6" [attr.y]="ref.labelY" dominant-baseline="middle">
              {{ ref.label }} · {{ num(ref.value) }}
            </text>
          }

          @for (s of g.lines; track s.id) {
            <path [attr.d]="s.path" fill="none" [attr.stroke]="s.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          }
          @for (s of g.dots; track s.id) {
            @for (p of s.points; track $index) {
              <circle [attr.cx]="p.x" [attr.cy]="p.y" r="4" [attr.fill]="s.color" class="dot" />
            }
          }

          @if (hover(); as h) {
            <line class="crosshair" [attr.x1]="h.x" [attr.x2]="h.x" [attr.y1]="g.top" [attr.y2]="g.bottom" />
            @for (row of h.rows; track row.id) {
              @if (row.y !== null) {
                <circle [attr.cx]="h.x" [attr.cy]="row.y" r="4" [attr.fill]="row.color" class="dot" />
              }
            }
          }
        </svg>

        @if (hover(); as h) {
          <div class="tooltip" [style.left.px]="h.tooltipX" [class.flip]="h.flip">
            <div class="tooltip-title">{{ dateLong(h.t) }}</div>
            @for (row of h.rows; track row.id) {
              <div class="tooltip-row">
                <svg width="12" height="8" aria-hidden="true"><line x1="0" y1="4" x2="12" y2="4" [attr.stroke]="row.color" stroke-width="2" stroke-linecap="round" /></svg>
                <strong>{{ row.value === null ? '–' : num(row.value) + ' ' + unit() }}</strong>
                <span>{{ row.label }}{{ row.note ? ' · ' + row.note : '' }}</span>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; position: relative; }
    .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 8px; padding: 0; list-style: none;
      font: var(--mat-sys-body-small); color: var(--mat-sys-on-surface-variant); }
    .legend li { display: inline-flex; align-items: center; gap: 6px; }
    .plot { position: relative; touch-action: pan-y; }
    svg { display: block; overflow: visible; }
    .grid { stroke: var(--chart-grid); stroke-width: 1; }
    .axis { font: var(--mat-sys-label-small); fill: var(--mat-sys-on-surface-variant); font-variant-numeric: tabular-nums; }
    .shade { fill: var(--mat-sys-on-surface); opacity: 0.04; }
    .ref { stroke: var(--mat-sys-on-surface-variant); stroke-width: 1; stroke-dasharray: 4 3; opacity: 0.7; }
    .ref-label { font: var(--mat-sys-label-small); fill: var(--mat-sys-on-surface-variant); }
    .dot { stroke: var(--chart-surface); stroke-width: 2; }
    .crosshair { stroke: var(--mat-sys-on-surface-variant); stroke-width: 1; }
    .tooltip { position: absolute; top: 8px; transform: translateX(12px); pointer-events: none; z-index: 2;
      min-width: 180px; padding: 8px 10px; border-radius: 8px; background: var(--mat-sys-surface-container-highest);
      color: var(--mat-sys-on-surface); box-shadow: var(--mat-sys-level2); font: var(--mat-sys-body-small); }
    .tooltip.flip { transform: translateX(calc(-100% - 12px)); }
    .tooltip-title { margin-bottom: 4px; color: var(--mat-sys-on-surface-variant); }
    .tooltip-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .tooltip-row strong { font: var(--mat-sys-label-large); }
    .tooltip-row span { color: var(--mat-sys-on-surface-variant); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LineChart {
  readonly series = input.required<LineSeries[]>();
  readonly refLines = input<RefLine[]>([]);
  readonly height = input(280);
  readonly unit = input('kulcs');
  /** Az x-tengely kezdete (ms); előtte nem rajzolunk. */
  readonly from = input<number | null>(null);
  /** Az elemzési ablak kezdete (ms): előtte halvány sáv jelzi, hogy az csak a visszateszthez számít. */
  readonly windowStart = input<number | null>(null);
  readonly ariaLabel = input('Idősor-diagram');

  protected readonly width = signal(0);
  protected readonly hover = signal<{
    t: number; x: number; tooltipX: number; flip: boolean;
    rows: { id: string; label: string; color: string; value: number | null; y: number | null; note?: string }[];
  } | null>(null);

  protected readonly num = (v: number) => formatNumber(v, 3);
  protected readonly compact = formatCompact;
  protected readonly date = formatDate;
  protected readonly dateLong = formatDateLong;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const observer = new ResizeObserver(([entry]) => this.width.set(Math.floor(entry.contentRect.width)));
      observer.observe(this.host.nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected readonly geometry = computed(() => {
    const width = this.width();
    const height = this.height();
    const series = this.series();
    const all = series.flatMap((s) => s.points);
    if (all.length === 0) return null;

    const now = Date.now();
    const t0 = this.from() ?? Math.min(...all.map((p) => p.t));
    const t1 = Math.max(now, ...all.map((p) => p.t));
    const visible = all.filter((p) => p.t >= t0);
    const values = [...visible, ...series.filter((s) => s.kind === 'step').map((s) => ({ v: stepValueAt(s.points, t0) ?? NaN }))]
      .map((p) => p.v)
      .filter(Number.isFinite);
    const refs = this.refLines().filter((r) => Number.isFinite(r.value) && r.value > 0);
    const [d0, d1] = niceDomain(Math.min(...values, ...refs.map((r) => r.value)), Math.max(...values, ...refs.map((r) => r.value)));

    const left = MARGIN.left;
    const right = Math.max(left + 50, width - MARGIN.right);
    const top = MARGIN.top;
    const bottom = height - MARGIN.bottom;
    const x = linear(t0, t1, left, right);
    const y = linear(d0, d1, bottom, top);

    // Lépcsős vonal: vízszintesen a következő bejegyzésig, ott függőlegesen az új árra; az utolsó ár mostanáig tart
    const lines = series.filter((s) => s.kind === 'step').map((s) => {
      const start = stepValueAt(s.points, t0);
      const pts = [...(start !== null ? [{ t: t0, v: start }] : []), ...s.points.filter((p) => p.t > t0)];
      let d = '';
      pts.forEach((p, i) => {
        d += i === 0 ? `M${x(p.t)},${y(p.v)}` : `H${x(p.t)}V${y(p.v)}`;
      });
      if (pts.length) d += `H${x(t1)}`;
      return { id: s.id, color: s.color, path: d };
    });
    const dots = series.filter((s) => s.kind === 'dots').map((s) => ({
      id: s.id,
      color: s.color,
      points: s.points.filter((p) => p.t >= t0).map((p) => ({ x: x(p.t), y: y(p.v) })),
    }));

    // Referenciavonalak feliratai: ha túl közel vannak, egymás alá toljuk őket (a vonal a helyén marad)
    const placed = refs.map((r) => ({ ...r, y: y(r.value), labelY: y(r.value) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < placed.length; i++) {
      if (placed[i].labelY - placed[i - 1].labelY < 13) placed[i].labelY = placed[i - 1].labelY + 13;
    }

    const ws = this.windowStart();
    return {
      left, right, top, bottom, x, y, t0, t1,
      yTicks: niceTicks(d0, d1, 5),
      xTicks: timeTicks(t0, t1, Math.max(2, Math.floor((right - left) / 90))),
      lines, dots, refs: placed,
      shade: ws && ws > t0 ? x(ws) - left : null,
    };
  });

  protected onMove(event: PointerEvent) {
    const g = this.geometry();
    if (!g) return;
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    const px = Math.min(Math.max(event.clientX - rect.left, g.left), g.right);
    const t = g.t0 + ((px - g.left) / (g.right - g.left)) * (g.t1 - g.t0);
    const rows = this.series().map((s) => {
      if (s.kind === 'step') {
        const value = stepValueAt(s.points, t);
        return { id: s.id, label: s.label, color: s.color, value, y: value === null ? null : g.y(value) };
      }
      // Pontsorozat: a legközelebbi pont, ha 3 napon belül van
      let best = -1;
      s.points.forEach((p, i) => {
        if (Math.abs(p.t - t) <= 3 * DAY && (best < 0 || Math.abs(p.t - t) < Math.abs(s.points[best].t - t))) best = i;
      });
      const p = best >= 0 ? s.points[best] : null;
      return { id: s.id, label: s.label, color: s.color, value: p?.v ?? null, y: p ? g.y(p.v) : null, note: p ? s.notes?.[best] : undefined };
    });
    const flip = px > (g.left + g.right) / 2;
    this.hover.set({ t, x: px, tooltipX: px, flip, rows });
  }
}
