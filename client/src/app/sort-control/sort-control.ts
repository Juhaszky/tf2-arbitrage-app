import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SortState } from '../core/sorting';

/** Rendezési szempont választása és az irány megfordítása. */
@Component({
  selector: 'app-sort-control',
  imports: [MatButtonModule, MatFormFieldModule, MatIconModule, MatSelectModule, MatTooltipModule],
  template: `
    <mat-form-field appearance="outline" subscriptSizing="dynamic" class="field">
      <mat-label>Rendezés</mat-label>
      <mat-select [value]="state().id" (selectionChange)="sortChange.emit($event.value)">
        @for (option of options(); track option.id) {
          <mat-option [value]="option.id">{{ option.label }}</mat-option>
        }
      </mat-select>
    </mat-form-field>
    <button
      mat-icon-button
      type="button"
      (click)="dirToggle.emit()"
      [matTooltip]="state().dir === 'asc' ? 'Növekvő – kattints a csökkenőhöz' : 'Csökkenő – kattints a növekvőhöz'"
      [attr.aria-label]="dirLabel()"
    >
      <mat-icon>{{ state().dir === 'asc' ? 'arrow_upward' : 'arrow_downward' }}</mat-icon>
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .field {
      width: 230px;
    }

    @media (max-width: 600px) {
      :host {
        width: 100%;
      }

      .field {
        flex: 1;
        width: auto;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SortControl {
  readonly options = input.required<{ id: string; label: string }[]>();
  readonly state = input.required<SortState>();

  readonly sortChange = output<string>();
  readonly dirToggle = output<void>();

  protected readonly dirLabel = computed(() => `Rendezés iránya: ${this.state().dir === 'asc' ? 'növekvő' : 'csökkenő'}`);
}
