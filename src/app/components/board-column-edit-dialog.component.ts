import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
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
  ],
  template: `
    <h2 mat-dialog-title>列設定を編集</h2>
    <div mat-dialog-content class="dialog-body">
      <form class="dialog-form" (ngSubmit)="onSave()">
        <mat-form-field appearance="outline" class="field">
          <mat-label>タイトル</mat-label>
          <input matInput name="title" [(ngModel)]="title" required maxlength="120" />
        </mat-form-field>

        <mat-form-field appearance="outline" class="field">
          <mat-label>扱いカテゴリ</mat-label>
          <mat-select name="category" [(ngModel)]="category">
            <mat-option [value]="'not_started'">未着手扱い</mat-option>
            <mat-option [value]="'in_progress'">進行中扱い</mat-option>
            <mat-option [value]="'done'">完了扱い</mat-option>
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="field">
          <mat-label>進捗率として扱う%</mat-label>
          <input
            matInput
            type="number"
            name="progress"
            min="0"
            max="100"
            [(ngModel)]="progress"
          />
        </mat-form-field>
      </form>
    </div>

    <div mat-dialog-actions align="end">
      <button mat-button type="button" (click)="onCancel()">キャンセル</button>
      <button mat-raised-button color="primary" type="button" [disabled]="!canSave()" (click)="onSave()">
        保存
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

    .field {
      width: 100%;
    }
  `,
})
export class BoardColumnEditDialogComponent {
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
    return !!trimmed && ['not_started', 'in_progress', 'done'].includes(this.category);
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
