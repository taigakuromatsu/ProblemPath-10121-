// src/app/components/board-column-edit-dialog.component.ts
import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';
import { BoardColumn, BoardColumnCategoryHint } from '../models/types';

export type BoardColumnEditDialogResult = Pick<BoardColumn, 'title' | 'categoryHint' | 'progressHint'>;

export interface BoardColumnEditDialogData {
  column: BoardColumn;
}

@Component({
  standalone: true,
  selector: 'pp-board-column-edit-dialog',
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    TranslateModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'board.columnEdit.dialogTitle' | translate }}</h2>

    <div mat-dialog-content class="dialog-body">
      <form class="dialog-form" (ngSubmit)="onSave()">
        <mat-form-field appearance="outline" class="field">
          <mat-label>{{ 'board.columnEdit.field.title' | translate }}</mat-label>
          <input
            matInput
            name="title"
            [(ngModel)]="title"
            required
            [attr.maxlength]="MAX_TITLE_LEN"
            [attr.aria-label]="'board.columnEdit.field.title' | translate"
          />
          <mat-hint>
            {{ 'board.columnEdit.hint.titleLength' | translate:{ min: MIN_TITLE_LEN, max: MAX_TITLE_LEN } }}
          </mat-hint>
        </mat-form-field>

        <mat-form-field appearance="outline" class="field">
          <mat-label>{{ 'board.columnEdit.field.category' | translate }}</mat-label>
          <mat-select
            name="category"
            [(ngModel)]="category"
            [attr.aria-label]="'board.columnEdit.field.category' | translate"
          >
            <mat-option [value]="'not_started'">{{ 'board.columnEdit.category.not_started' | translate }}</mat-option>
            <mat-option [value]="'in_progress'">{{ 'board.columnEdit.category.in_progress' | translate }}</mat-option>
            <mat-option [value]="'done'">{{ 'board.columnEdit.category.done' | translate }}</mat-option>
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="field">
          <mat-label>{{ 'board.columnEdit.field.progress' | translate }}</mat-label>
          <input
            matInput
            type="number"
            name="progress"
            min="0"
            max="100"
            [(ngModel)]="progress"
            [attr.aria-label]="'board.columnEdit.field.progress' | translate"
          />
        </mat-form-field>
      </form>
    </div>

    <div mat-dialog-actions align="end">
      <button mat-button type="button" (click)="onCancel()">
        {{ 'common.cancel' | translate }}
      </button>
      <button
        mat-raised-button
        color="primary"
        type="button"
        [disabled]="!canSave()"
        (click)="onSave()"
      >
        {{ 'common.save' | translate }}
      </button>
    </div>
  `,
  styles: `
    .dialog-body {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      min-width: 320px;
    }
    .dialog-form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .field { width: 100%; }
  `,
})
export class BoardColumnEditDialogComponent {
  readonly MIN_TITLE_LEN = 1;
  readonly MAX_TITLE_LEN = 20;

  title = '';
  category: BoardColumnCategoryHint = 'not_started';
  progress = 0;

  constructor(
    private dialogRef: MatDialogRef<BoardColumnEditDialogComponent, BoardColumnEditDialogResult | undefined>,
    @Inject(MAT_DIALOG_DATA) private data: BoardColumnEditDialogData,
  ) {
    this.title = data.column.title ?? '';
    this.category = data.column.categoryHint ?? 'not_started';
    this.progress = data.column.progressHint ?? 0;
  }

  canSave(): boolean {
    const trimmed = (this.title ?? '').trim();
    const len = trimmed.length;
    return (
      len >= this.MIN_TITLE_LEN &&
      len <= this.MAX_TITLE_LEN &&
      ['not_started', 'in_progress', 'done'].includes(this.category)
    );
  }

  onCancel() {
    this.dialogRef.close();
  }

  onSave() {
    if (!this.canSave()) return;
    const trimmedTitle = (this.title ?? '').trim();
    const numericProgress = Number(this.progress ?? 0);
    const clamped = Math.min(100, Math.max(0, Number.isFinite(numericProgress) ? numericProgress : 0));

    this.dialogRef.close({
      title: trimmedTitle,
      categoryHint: this.category,
      progressHint: clamped,
    });
  }
}

