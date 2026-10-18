import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { MatAutocompleteModule, MatAutocompleteSelectedEvent } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { catchError, debounceTime, distinctUntilChanged, finalize, map, of, switchMap, tap } from 'rxjs';
import { ApiService } from '../core/api.service';
import { ItemSearchResult } from '../core/models';
import { MarketStore } from '../core/market.store';

const MIN_QUERY = 2;

@Component({
  selector: 'app-add-item',
  imports: [MatAutocompleteModule, MatFormFieldModule, MatIconModule, MatInputModule, MatProgressSpinnerModule],
  templateUrl: './add-item.html',
  styleUrl: './add-item.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddItem {
  private readonly api = inject(ApiService);
  protected readonly store = inject(MarketStore);

  protected readonly query = signal('');
  protected readonly searching = signal(false);

  protected readonly results = toSignal(
    toObservable(this.query).pipe(
      map((q) => q.trim()),
      debounceTime(250),
      distinctUntilChanged(),
      switchMap((q) => {
        if (q.length < MIN_QUERY) return of<ItemSearchResult[]>([]);
        this.searching.set(true);
        return this.api.searchItems(q).pipe(
          catchError(() => of<ItemSearchResult[]>([])),
          finalize(() => this.searching.set(false)),
        );
      }),
    ),
    { initialValue: [] },
  );

  protected readonly noResults = () =>
    this.query().trim().length >= MIN_QUERY && !this.searching() && this.results().length === 0;

  // A kiválasztás után a mező kiürül
  protected readonly display = () => '';

  protected onInput(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected select(event: MatAutocompleteSelectedEvent) {
    const item = event.option.value as ItemSearchResult;
    this.query.set('');
    void this.store.watch(item);
  }
}
