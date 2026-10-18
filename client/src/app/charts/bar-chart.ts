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
import { formatCompact, linear, niceDomain, niceTicks } from './chart-utils';

export interface Bar {
  /** Az x-tengely felirata (csak minden n-edik látszik, ha sok van). */
  label: string;
  value: number;
  /** CSS szín (változó). */
  color: string;
  /** Az adatsáv sorai: az első a kiemelt érték, a többi kiegészítő. */
  tooltip: string[];
}

const MARGIN = { top: 12, right: 12, bottom: 28, left: 52 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/**
 * Oszlopdiagram egyetlen tengellyel (negatív értékekkel is): legfeljebb 24 px széles oszlopok, 4 px-es lekerekített
 * véggel és szögletes alappal, köztük 2 px rés. Az oszlop (és a teljes sávja) a célterület: rámutatva megjelenik az adatsáv.
 */
@Component({
  selector: 'app-bar-chart',
  template: `
    <div class="plot" [style.height.px]="height()">
      @if (width() > 0 && geometry(); as g) {
        <svg [attr.width]="width()" [attr.height]="height()" role="img" [attr.aria-label]="ariaLabel()" (pointerleave)="hover.set(null)">
          @for (tick of g.yTicks; track tick) {
            <line class="grid" [attr.x1]="g.left" [attr.x2]="g.right" [attr.y1]="g.y(tick)" [attr.y2]="g.y(tick)" />
            <text class="axis" [attr.x]="g.left - 8" [attr.y]="g.y(tick)" text-anchor="end" dominant-baseline="middle">{{ compact(tick) }}</text>
          }
          @for (b of g.bars; track $index) {
            <rect class="hit" [attr.x]="b.slotX" [attr.y]="g.top" [attr.width]="b.slotW" [attr.height]="g.bottom - g.top"
              (pointerenter)="hover.set($index)" />
            <path [attr.d]="b.path" [attr.fill]="b.color" [class.lifted]="hover() === $index" />
            @if (b.showLabel) {
              <text class="axis" [attr.x]="b.cx" [attr.y]="height() - 8" text-anchor="middle">{{ b.label }}</text>
            }
          }
          <line class="baseline" [attr.x1]="g.left" [attr.x2]="g.right" [attr.y1]="g.y(0)" [attr.y2]="g.y(0)" />
          @if (marker(); as m) {
            @if (g.markerX !== null) {
              <line class="marker" [attr.x1]="g.markerX" [attr.x2]="g.markerX" [attr.y1]="g.top" [attr.y2]="g.bottom" />
              <text class="marker-label" [attr.x]="g.markerX + 4" [attr.y]="g.top + 10">{{ m.label }}</text>
            }
          }
        </svg>
        @if (hover() !== null && g.bars[hover()!]; as b) {
          <div class="tooltip" [style.left.px]="b.cx" [class.flip]="b.cx > (g.left + g.right) / 2">
            @for (line of b.tooltip; track $index; let first = $first) {
              @if (first) {
                <div class="tooltip-row">
                  <svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" [attr.fill]="b.color" /></svg>
                  <strong>{{ line }}</strong>
                </div>
              } @else {
                <div class="tooltip-sub">{{ line }}</div>
              }
            }
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; position: relative; }
    .plot { position: relative; }
    svg { display: block; overflow: visible; }
    .grid { stroke: var(--chart-grid); stroke-width: 1; }
    .baseline { stroke: var(--mat-sys-on-surface-variant); stroke-width: 1; }
    .axis { font: var(--mat-sys-label-small); fill: var(--mat-sys-on-surface-variant); font-variant-numeric: tabular-nums; }
    .hit { fill: transparent; }
    path { transition: opacity 120ms; pointer-events: none; }
    path.lifted { opacity: 0.75; }
    .marker { stroke: var(--mat-sys-on-surface); stroke-width: 1; stroke-dasharray: 4 3; }
    .marker-label { font: var(--mat-sys-label-small); fill: var(--mat-sys-on-surface); }
    .tooltip { position: absolute; top: 8px; transform: translateX(12px); pointer-events: none; z-index: 2;
      min-width: 160px; padding: 8px 10px; border-radius: 8px; background: var(--mat-sys-surface-container-highest);
      color: var(--mat-sys-on-surface); box-shadow: var(--mat-sys-level2); font: var(--mat-sys-body-small); }
    .tooltip.flip { transform: translateX(calc(-100% - 12px)); }
    .tooltip-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .tooltip-row strong { font: var(--mat-sys-label-large); }
    .tooltip-sub { color: var(--mat-sys-on-surface-variant); white-space: nowrap; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BarChart {
  readonly bars = input.required<Bar[]>();
  readonly height = input(200);
  readonly ariaLabel = input('Oszlopdiagram');
  /** Függőleges jelölő egy oszlop-index (törtszám is lehet) helyén, pl. a 0%-os hozam határa. */
  readonly marker = input<{ index: number; label: string } | null>(null);

  protected readonly width = signal(0);
  protected readonly hover = signal<number | null>(null);
  protected readonly compact = formatCompact;

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
    const bars = this.bars();
    const width = this.width();
    const height = this.height();
    if (bars.length === 0) return null;

    const values = bars.map((b) => b.value);
    const [d0, d1] = niceDomain(Math.min(0, ...values), Math.max(0, ...values), 4);
    const left = MARGIN.left;
    const right = width - MARGIN.right;
    const top = MARGIN.top;
    const bottom = height - MARGIN.bottom;
    const y = linear(d0, d1, bottom, top);
    const slotW = (right - left) / bars.length;
    const barW = Math.max(1, Math.min(MAX_BAR, slotW - GAP));
    const labelEvery = Math.max(1, Math.ceil(56 / slotW));
    const zero = y(0);

    return {
      left, right, top, bottom, y,
      yTicks: niceTicks(d0, d1, 4),
      markerX: this.marker() ? left + this.marker()!.index * slotW : null,
      bars: bars.map((b, i) => {
        const cx = left + (i + 0.5) * slotW;
        const x0 = cx - barW / 2;
        const yv = y(b.value);
        const h = Math.abs(zero - yv);
        const r = Math.min(RADIUS, h, barW / 2);
        // Lekerekített adatvég, szögletes alap (pozitívnál felül, negatívnál alul kerekítünk)
        const path = h < 0.5 ? '' : b.value >= 0
          ? `M${x0},${zero}V${yv + r}Q${x0},${yv} ${x0 + r},${yv}H${x0 + barW - r}Q${x0 + barW},${yv} ${x0 + barW},${yv + r}V${zero}Z`
          : `M${x0},${zero}V${yv - r}Q${x0},${yv} ${x0 + r},${yv}H${x0 + barW - r}Q${x0 + barW},${yv} ${x0 + barW},${yv - r}V${zero}Z`;
        return { ...b, cx, slotX: left + i * slotW, slotW, path, showLabel: i % labelEvery === 0 };
      }),
    };
  });
}
