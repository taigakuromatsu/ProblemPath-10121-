// src/app/components/ai-issue-suggest.component.ts
import { Component, EventEmitter, Input, Output, OnChanges, SimpleChanges, OnInit, OnDestroy } from '@angular/core';
import { NgIf, NgFor } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AiService } from '../services/ai.service';
import { Problem } from '../models/types';
import { CurrentProjectService } from '../services/current-project.service';
import { Subscription } from 'rxjs';

@Component({
  standalone: true,
  selector: 'pp-ai-issue-suggest',
  imports: [NgIf, NgFor, MatButtonModule, MatChipsModule, MatIconModule, TranslateModule],
  template: `
    <div class="ai-suggest">
      <button
        mat-stroked-button
        type="button"
        [disabled]="loading || disabled || !canSuggest"
        (click)="onSuggest()">
        <mat-icon>auto_awesome</mat-icon>
        {{ 'ai.suggestIssuesBtn' | translate }}
      </button>

      <!-- 不足時のヒント（ボタンの直下に小さく表示） -->
      <div class="ai-suggest__hint" *ngIf="!loading && !error && !canSuggest">
        {{ needMsg }}
      </div>

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
    .ai-suggest__hint { color: var(--muted); font-size: 12px; line-height: 1.4; }
  `]
})
export class AiIssueSuggestComponent implements OnInit, OnChanges, OnDestroy {
  @Input() problem: Problem | null = null;
  @Input() disabled = false;
  @Output() pick = new EventEmitter<string>();

  private readonly MIN_TITLE = 4;
  private readonly MIN_PHEN = 20;
  private readonly MIN_GOAL = 20;

  suggestions: string[] = [];
  loading = false;
  error: string | null = null;

  canSuggest = false;
  needMsg: string | null = null;

  private subs = new Subscription();

  constructor(
    private ai: AiService,
    private tr: TranslateService,
    private current: CurrentProjectService,
  ) {}

  ngOnInit(): void {
    // 言語が切り替わった/翻訳がロードされたらヒント文を再生成
    this.subs.add(this.tr.onLangChange.subscribe(() => this.recompute()));
    this.subs.add(this.tr.onTranslationChange.subscribe(() => this.recompute()));
    this.subs.add(this.tr.onDefaultLangChange.subscribe(() => this.recompute()));
  }

  ngOnChanges(_: SimpleChanges): void {
    this.recompute();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  private t(key: string, fallback: string): string {
    const v = this.tr.instant(key);
    return v === key ? fallback : v;
  }
  private tp(key: string, params: Record<string, any>, fallback: string): string {
    const v = this.tr.instant(key, params);
    return v === key ? fallback : v;
  }

  private _norm(s?: string | null): string {
    return (s ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  }
  private _isSameCharOnly(s?: string | null): boolean {
    const t = this._norm(s).replace(/\s/gu, '');
    return !!t && /^(.)(\1)+$/u.test(t);
  }
  private _isNumericOnly(s?: string | null): boolean {
    const t = this._norm(s).replace(/\s/gu, '');
    return !!t && /^\p{Nd}+$/u.test(t);
  }
  private _letterRatio(s?: string | null): number {
    const t = this._norm(s).replace(/\s/gu, '');
    if (!t) return 0;
    const letters = (t.match(/\p{L}/gu) || []).length;
    return letters / t.length;
  }
  private normLen(s?: string | null): number {
    return this._norm(s).length;
  }

  private _validateForSuggest(p: Problem): string | null {
    const title = this._norm(p.title);
    const ph    = this._norm((p as any).problemDef?.phenomenon ?? '');
    const goal  = this._norm((p as any).problemDef?.goal ?? '');

    if (title.length < this.MIN_TITLE) {
      return this.tp('ai.min.title', { n: this.MIN_TITLE, cur: title.length },
        `タイトル ${this.MIN_TITLE}文字以上（現在${title.length}）`);
    }
    if (ph.length < this.MIN_PHEN) {
      return this.tp('ai.min.phenomenon', { n: this.MIN_PHEN, cur: ph.length },
        `現象 ${this.MIN_PHEN}文字以上（現在${ph.length}）`);
    }
    if (goal.length < this.MIN_GOAL) {
      return this.tp('ai.min.goal', { n: this.MIN_GOAL, cur: goal.length },
        `目標 ${this.MIN_GOAL}文字以上（現在${goal.length}）`);
    }

    const checks: Array<[boolean, string, string]> = [
      [this._isSameCharOnly(title), 'validation.samechar.problemTitle', 'タイトルが同一文字の繰り返しです'],
      [this._isNumericOnly(title),  'validation.numeric.problemTitle',  'タイトルを数字だけで入力することはできません'],
      [this._letterRatio(title) < 0.3, 'validation.letters.problemTitle', 'タイトルに自然文（日本語/英字）を含めてください'],

      [this._isSameCharOnly(ph),    'validation.samechar.phenomenon',   '現象が同一文字の繰り返しです'],
      [this._isNumericOnly(ph),     'validation.numeric.phenomenon',    '現象を数字だけで入力することはできません'],
      [this._letterRatio(ph) < 0.3, 'validation.letters.phenomenon',    '現象に自然文（日本語/英字）を含めてください'],

      [this._isSameCharOnly(goal),  'validation.samechar.goal',          '目標が同一文字の繰り返しです'],
      [this._isNumericOnly(goal),   'validation.numeric.goal',           '目標を数字だけで入力することはできません'],
      [this._letterRatio(goal) < 0.3, 'validation.letters.goal',         '目標に自然文（日本語/英字）を含めてください'],
    ];
    for (const [bad, key, fb] of checks) {
      if (bad) return this.t(key, fb);
    }
    return null;
  }

  private recompute() {
    const title = (this.problem?.title) ?? '';
    const phen  = (this as any).problem?.problemDef?.phenomenon ?? '';
    const goal  = (this as any).problem?.problemDef?.goal ?? '';

    const titleLen = this.normLen(title);
    const phenLen  = this.normLen(phen);
    const goalLen  = this.normLen(goal);

    const lacks: string[] = [];

    if (titleLen < this.MIN_TITLE) {
      lacks.push(this.tp('ai.min.title', { n: this.MIN_TITLE, cur: titleLen },
        `タイトル ${this.MIN_TITLE}文字以上（現在${titleLen}）`));
    }
    if (phenLen < this.MIN_PHEN) {
      lacks.push(this.tp('ai.min.phenomenon', { n: this.MIN_PHEN, cur: phenLen },
        `現象 ${this.MIN_PHEN}文字以上（現在${phenLen}）`));
    }
    if (goalLen < this.MIN_GOAL) {
      lacks.push(this.tp('ai.min.goal', { n: this.MIN_GOAL, cur: goalLen },
        `目標 ${this.MIN_GOAL}文字以上（現在${goalLen}）`));
    }

    if (lacks.length === 0) {
      if (this._isSameCharOnly(title)) lacks.push(this.t('validation.samechar.problemTitle', 'タイトルが同一文字の繰り返しです'));
      else if (this._isNumericOnly(title)) lacks.push(this.t('validation.numeric.problemTitle', 'タイトルを数字だけで入力することはできません'));
      else if (this._letterRatio(title) < 0.3) lacks.push(this.t('validation.letters.problemTitle', 'タイトルに自然文（日本語/英字）を含めてください'));

      if (this._isSameCharOnly(phen)) lacks.push(this.t('validation.samechar.phenomenon', '現象が同一文字の繰り返しです'));
      else if (this._isNumericOnly(phen)) lacks.push(this.t('validation.numeric.phenomenon', '現象を数字だけで入力することはできません'));
      else if (this._letterRatio(phen) < 0.3) lacks.push(this.t('validation.letters.phenomenon', '現象に自然文（日本語/英字）を含めてください'));

      if (this._isSameCharOnly(goal)) lacks.push(this.t('validation.samechar.goal', '目標が同一文字の繰り返しです'));
      else if (this._isNumericOnly(goal)) lacks.push(this.t('validation.numeric.goal', '目標を数字だけで入力することはできません'));
      else if (this._letterRatio(goal) < 0.3) lacks.push(this.t('validation.letters.goal', '目標に自然文（日本語/英字）を含めてください'));
    }

    this.canSuggest = lacks.length === 0;
    this.needMsg = this.canSuggest
      ? null
      : this.t('ai.min.hintPrefix', 'AI提案を使うには ') + lacks.join(' / ');
  }

  async onSuggest() {
    this.error = null;
    this.suggestions = [];

    this.recompute();
    if (!this.canSuggest) {
      this.error = this.needMsg || this.t('ai.min.defaultError', '入力が短すぎます。必要な項目を満たしてください。');
      return;
    }

    const pid = this.current.getSync();
    if (!pid) {
      this.error = this.tr.instant('common.projectNotSelected');
      return;
    }
    if (!this.problem?.title) {
      this.error = this.tr.instant('ai.noProblem');
      return;
    }

    const violated = this._validateForSuggest(this.problem);
    if (violated) {
      this.error = violated;
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
          phenomenon: (this as any).problem?.problemDef?.phenomenon ?? '',
          cause:      (this as any).problem?.problemDef?.cause ?? '',
          solution:   (this as any).problem?.problemDef?.solution ?? '',
          goal:       (this as any).problem?.problemDef?.goal ?? '',
        }
      });
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
