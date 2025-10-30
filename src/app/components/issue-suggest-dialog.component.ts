import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';
import { IssueSuggestion } from '../services/ai-assist.service';

@Component({
  selector: 'pp-issue-suggest-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, TranslateModule],
  template: `
    <h2 mat-dialog-title>{{ 'assist.title' | translate }}</h2>
    <div mat-dialog-content class="dialog-content">
      <ng-container *ngIf="suggestions.length; else emptyState">
        <ol class="suggestions">
          <li *ngFor="let suggestion of suggestions" class="suggestion">
            <h3>{{ suggestion.title }}</h3>
            <p class="description" [innerText]="suggestion.description"></p>
            <div class="criteria" *ngIf="suggestion.acceptanceCriteria.length">
              <p class="criteria-title">{{ 'assist.acceptanceCriteria' | translate }}</p>
              <ul>
                <li *ngFor="let ac of suggestion.acceptanceCriteria">{{ ac }}</li>
              </ul>
            </div>
            <div class="actions">
              <button mat-stroked-button color="primary" (click)="onUse(suggestion)">{{ 'assist.useThis' | translate }}</button>
            </div>
          </li>
        </ol>
      </ng-container>
      <ng-template #emptyState>
        <p class="empty">{{ 'assist.empty' | translate }}</p>
      </ng-template>
    </div>
    <div mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>{{ 'common.close' | translate }}</button>
    </div>
  `,
  styles: [
    `
      .suggestions {
        padding-left: 1.5rem;
        margin: 0;
        display: grid;
        gap: 1rem;
      }
      .suggestion h3 {
        margin: 0 0 0.25rem;
        font-size: 1.1rem;
      }
      .description {
        white-space: pre-wrap;
        margin: 0 0 0.5rem;
      }
      .criteria-title {
        font-weight: 600;
        margin: 0 0 0.25rem;
      }
      .criteria ul {
        padding-left: 1.2rem;
        margin: 0 0 0.5rem;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
      }
      .empty {
        text-align: center;
        margin: 1.5rem 0;
      }
      .dialog-content {
        max-height: 60vh;
        overflow: auto;
      }
    `,
  ],
})
export class IssueSuggestDialogComponent {
  readonly suggestions: IssueSuggestion[];

  constructor(
    private readonly dialogRef: MatDialogRef<IssueSuggestDialogComponent>,
    @Inject(MAT_DIALOG_DATA) data: { suggestions?: IssueSuggestion[] }
  ) {
    this.suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
  }

  onUse(suggestion: IssueSuggestion): void {
    this.dialogRef.close(suggestion);
  }
}
