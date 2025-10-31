// src/app/components/ai-issue-suggest.component.ts

import { Component, EventEmitter, Input, Output } from '@angular/core';
import { NgIf, NgFor } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AiService } from '../services/ai.service';
import { Problem } from '../models/types';
import { CurrentProjectService } from '../services/current-project.service';

@Component({
  standalone: true,
  selector: 'pp-ai-issue-suggest',
  imports: [NgIf, NgFor, MatButtonModule, MatChipsModule, MatIconModule, TranslateModule],
  template: `
    <div class="ai-suggest">
      <button mat-stroked-button type="button"
        [disabled]="loading || disabled"
        (click)="onSuggest()">
        <mat-icon>auto_awesome</mat-icon>
        {{ 'ai.suggestIssuesBtn' | translate }}
      </button>

      <div class="ai-suggest__chips" *ngIf="suggestions?.length">
        <span class="muted">{{ 'ai.pickOne' | translate }}</span>
        <mat-chip-set>
          <mat-chip
            *ngFor="let s of suggestions"
            (click)="pick.emit(s)"
            appearance="outlined">{{ s }}</mat-chip>
        </mat-chip-set>
        <button mat-button type="button" (click)="clear()" aria-label="clear">
          {{ 'ai.clear' | translate }}
        </button>
      </div>

      <div class="ai-suggest__loading" *ngIf="loading">
        {{ 'ai.loading' | translate }}
      </div>

      <div class="ai-suggest__error" *ngIf="error">
        {{ 'ai.error' | translate }}: {{ error }}
      </div>
    </div>
  `,
  styles: [`
    .ai-suggest { display:flex; flex-direction:column; gap:8px; }
    .ai-suggest__chips { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .muted { color: var(--muted); font-size: 0.9em; }
    .ai-suggest__loading { color: var(--muted); }
    .ai-suggest__error { color: var(--accent-red); }
  `]
})
export class AiIssueSuggestComponent {
  @Input() problem: Problem | null = null;
  @Input() disabled = false;
  @Output() pick = new EventEmitter<string>();

  suggestions: string[] = [];
  loading = false;
  error: string | null = null;

  constructor(
    private ai: AiService,
    private tr: TranslateService,
    private current: CurrentProjectService,
  ) {}

  async onSuggest() {
    this.error = null;
    this.suggestions = [];
    const pid = this.current.getSync();
    if (!pid) {
      this.error = this.tr.instant('common.projectNotSelected');
      return;
    }
    if (!this.problem?.title) {
      this.error = this.tr.instant('ai.noProblem');
      return;
    }

    this.loading = true;
    try {
      const lang = (this.tr.currentLang === 'en' ? 'en' : 'ja') as 'ja'|'en';
      const out = await this.ai.suggestIssues({
        lang,
        projectId: pid,
        problem: {
          title: this.problem.title,
          phenomenon: this.problem.problemDef?.phenomenon ?? '',
          cause:      this.problem.problemDef?.cause ?? '',
          solution:   this.problem.problemDef?.solution ?? '',
          goal:       this.problem.problemDef?.goal ?? '',
        }
      });
      // out は string[] 前提
      this.suggestions = out;
    } catch (e: any) {
      this.error = e?.message ?? String(e);
    } finally {
      this.loading = false;
    }
  }

  clear() {
    this.suggestions = [];
    this.error = null;
  }
}
