import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AddItem } from './add-item/add-item';
import { RECOMMENDATION_LABELS, timeAgo } from './core/format';
import { Filter, TrackedStore } from './core/tracked.store';
import { ItemCard } from './item-card/item-card';

@Component({
  selector: 'app-root',
  imports: [
    AddItem,
    ItemCard,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatToolbarModule,
    MatTooltipModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(TrackedStore);
  protected readonly timeAgo = timeAgo;

  protected readonly filters: { value: Filter; label: string }[] = [
    { value: 'ALL', label: 'Összes' },
    ...(Object.entries(RECOMMENDATION_LABELS) as [Filter, string][]).map(([value, label]) => ({ value, label })),
  ];
}
