import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AddItem } from './add-item/add-item';
import { RECOMMENDATION_LABELS, timeAgo } from './core/format';
import { Filter, MarketStore } from './core/market.store';
import { InfiniteScroll } from './core/infinite-scroll.directive';
import { MARKET_LABELS } from './core/trade-plan';
import { DealCard } from './deal-card/deal-card';
import { ItemCard } from './item-card/item-card';
import { MarketFilterPanel } from './market-filter/market-filter';
import { SortControl } from './sort-control/sort-control';

@Component({
  selector: 'app-root',
  imports: [
    AddItem,
    DealCard,
    InfiniteScroll,
    ItemCard,
    MarketFilterPanel,
    SortControl,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatChipsModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatToolbarModule,
    MatTooltipModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(MarketStore);
  protected readonly timeAgo = timeAgo;
  protected readonly marketLabels: Record<string, string> = MARKET_LABELS;
  protected readonly count = (value: number) => value.toLocaleString('hu-HU');

  protected readonly filters: { value: Filter; label: string }[] = [
    { value: 'ALL', label: 'Összes' },
    ...(Object.entries(RECOMMENDATION_LABELS) as [Filter, string][]).map(([value, label]) => ({ value, label })),
  ];
}
