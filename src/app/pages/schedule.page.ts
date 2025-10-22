// src/app/pages/schedule.page.ts
import { Component, Input } from '@angular/core';
import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { Observable, combineLatest, of } from 'rxjs';
import { map, switchMap, startWith } from 'rxjs/operators';

import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { Task } from '../models/types';
import { take } from 'rxjs/operators';

type Vm = {
  overdue: Task[];
  today: Task[];
  tomorrow: Task[];
  thisWeekRest: Task[];
  nextWeek: Task[];
  later: Task[];
  nodue: Task[];
};

const EMPTY_VM: Vm = {
  overdue: [], today: [], tomorrow: [],
  thisWeekRest: [], nextWeek: [], later: [], nodue: []
};

/* =======================
   行コンポーネント
   ======================= */
@Component({
  standalone: true,
  selector: 'pp-schedule-row',
  imports: [NgIf, RouterLink, MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
  <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid #e5e7eb; border-radius:8px; margin-bottom:6px;">
    <span [style.opacity]="t.status==='done' ? .6 : 1" style="flex:1 1 auto;">
      <strong>{{ t.title }}</strong>
      <span *ngIf="t.priority" style="font-size:12px; margin-left:6px; opacity:.8;">[{{ t.priority }}]</span>
      <span *ngIf="t.dueDate" style="font-size:12px; margin-left:8px; opacity:.8;">
        due: {{ t.dueDate }}
      </span>
    </span>

    <!-- Boardへ（problemId/issueId がある場合だけリンク） -->
    <a *ngIf="t.problemId && t.issueId"
       mat-stroked-button
       [routerLink]="['/board']"
       [queryParams]="{ pid: t.problemId }"
       matTooltip="Boardで見る">Board</a>
  </div>
  `
})
export class ScheduleRow {
  @Input() t!: Task;
}

/* =======================
   一覧（pid追従・フィルタ有）
   ======================= */

@Component({
  standalone: true,
  selector: 'pp-schedule',
  imports: [
    AsyncPipe, NgFor, NgIf, FormsModule,
    MatButtonModule, MatIconModule, MatSelectModule, MatTooltipModule,
    RouterLink, ScheduleRow
  ],
  template: `
  <div style="display:flex; align-items:center; gap:12px; margin:8px 0 16px;">
    <a mat-stroked-button routerLink="/tree">← Treeへ</a>
    <h3 style="margin:0;">Schedule</h3>
    <span style="flex:1 1 auto;"></span>

    <button mat-stroked-button (click)="exportCurrent('csv')">CSV</button>
    <button mat-stroked-button style="margin-left:6px;" (click)="exportCurrent('json')">JSON</button>

    <label>表示:
      <select [(ngModel)]="openOnly" (ngModelChange)="reload()">
        <option [ngValue]="true">未完了のみ</option>
        <option [ngValue]="false">すべて</option>
      </select>
    </label>

    <label style="margin-left:8px;">タグ:
      <input
        [(ngModel)]="tagQuery"
        (ngModelChange)="reload()"
        placeholder="#bug #UI（スペース区切り）"
        style="padding:4px 8px; border:1px solid #e5e7eb; border-radius:6px;"/>
    </label>
  </div>

  <ng-container *ngIf="vm$ | async as vm">
    <section>
      <h4 style="margin:12px 0;">⚠️ 期限切れ（{{ vm.overdue.length }}）</h4>
      <div *ngIf="!vm.overdue.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.overdue; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">📅 今日（{{ vm.today.length }}）</h4>
      <div *ngIf="!vm.today.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.today; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">🗓 明日（{{ vm.tomorrow.length }}）</h4>
      <div *ngIf="!vm.tomorrow.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.tomorrow; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">🗓 今週の残り（{{ vm.thisWeekRest.length }}）</h4>
      <div *ngIf="!vm.thisWeekRest.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.thisWeekRest; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">🗓 来週（{{ vm.nextWeek.length }}）</h4>
      <div *ngIf="!vm.nextWeek.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.nextWeek; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">📆 以降（{{ vm.later.length }}）</h4>
      <div *ngIf="!vm.later.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.later; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">— 期限未設定（{{ vm.nodue.length }}）</h4>
      <div *ngIf="!vm.nodue.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.nodue; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>
  </ng-container>
  `
})

export class SchedulePage {


  vm$: Observable<Vm> = of(EMPTY_VM);

  openOnly = true;
  tagQuery = '';



  constructor(
    private tasks: TasksService,
    private currentProject: CurrentProjectService
  ) {}

  ngOnInit() { this.reload(); }

  trackTask = (_: number, t: Task) => t.id;

  private ymd(d: Date): string {
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, '0');
    const da = d.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${da}`;
  }
  private addDays(base: Date, n: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d;
  }
  private parseTags(q: string): string[] {
    return (q || '')
      .split(/\s+/)
      .map(s => s.replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  reload() {
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = this.addDays(today, 1);

    // 今週（月曜始まり）
    const day = today.getDay(); // Sun=0
    const diffToMon = (day === 0 ? -6 : 1 - day);
    const startOfWeek = this.addDays(today, diffToMon);
    const endOfWeek   = this.addDays(startOfWeek, 6);

    // 来週
    const startOfNextWeek = this.addDays(endOfWeek, 1);
    const endOfNextWeek   = this.addDays(startOfNextWeek, 6);

    const dayAfterTomorrow = this.addDays(tomorrow, 1);
    const FAR_FUTURE = '9999-12-31';
    const tags = this.parseTags(this.tagQuery);

    // openOnly/tagQuery の変更でも即時反映したいので startWith でトリガに
    const params$ = of(null).pipe(startWith(null));

    this.vm$ = combineLatest([this.currentProject.projectId$, params$]).pipe(
      switchMap(([pid]) => {
        if (!pid) {
          const empty: Vm = {
            overdue: [], today: [], tomorrow: [],
            thisWeekRest: [], nextWeek: [], later: [], nodue: []
          };
          return of(empty);
        }

        const overdue$      = this.tasks.listAllOverdue(pid, this.ymd(today), this.openOnly, tags);
        const today$        = this.tasks.listAllByDueRange(pid, this.ymd(today), this.ymd(today), this.openOnly, tags);
        const tomorrow$     = this.tasks.listAllByDueRange(pid, this.ymd(tomorrow), this.ymd(tomorrow), this.openOnly, tags);

        const thisWeekRest$ = this.tasks.listAllByDueRange(pid, this.ymd(this.addDays(tomorrow, 1)), this.ymd(endOfWeek), this.openOnly, tags);
        const nextWeek$     = this.tasks.listAllByDueRange(pid, this.ymd(startOfNextWeek), this.ymd(endOfNextWeek), this.openOnly, tags);
        const later$        = this.tasks.listAllByDueRange(pid, this.ymd(this.addDays(endOfNextWeek, 1)), FAR_FUTURE, this.openOnly, tags);

        const nodue$        = this.tasks.listAllNoDue(pid, this.openOnly, tags);

        return combineLatest([overdue$, today$, tomorrow$, thisWeekRest$, nextWeek$, later$, nodue$]).pipe(
          map(([overdue, today, tomorrow, thisWeekRest, nextWeek, later, nodue]) => ({
            overdue, today, tomorrow, thisWeekRest, nextWeek, later, nodue
          }))
        );
      })
    );
  }

  private flattenVm(vm: Vm){
    return [
      ...vm.overdue, ...vm.today, ...vm.tomorrow,
      ...vm.thisWeekRest, ...vm.nextWeek, ...vm.later, ...vm.nodue
    ];
  }
  
  private toCsv(tasks: Task[]): string {
    const headers = [
      'ID','タイトル','状態','優先度','期日','担当者','プロジェクトID',
      'ProblemID','IssueID','タグ','進捗(%)','作成日時','更新日時'
    ];
    const esc = (v: any) => `"${(v ?? '').toString().replace(/"/g,'""')}"`;
    const fmtTs = (x: any) => {
      // Firestore Timestamp → ISO8601 / その他は空 or 文字列
      const d = x?.toDate?.() ?? (typeof x === 'string' ? new Date(x) : null);
      return d && !isNaN(d as any) ? new Date(d).toISOString().replace('T',' ').replace('Z','') : '';
    };
    const join = (xs: any) => Array.isArray(xs) ? xs.join(', ') : (xs ?? '');
  
    const rows = tasks.map(t => [
      t.id,
      t.title,
      t.status,           // 必要ならここでラベル化: map {in_progress:'対応中',...}
      t.priority ?? '',
      t.dueDate ?? '',
      join(t.assignees),
      t.projectId ?? '',
      t.problemId ?? '',
      t.issueId ?? '',
      join(t.tags),
      (t as any).progress ?? '',
      fmtTs((t as any).createdAt),
      fmtTs((t as any).updatedAt),
    ].map(esc).join(','));
  
    return [headers.join(','), ...rows].join('\n');
  }
  
  
  private download(filename: string, content: string, mime = 'text/plain') {
    const bom = mime === 'text/csv' ? '\uFEFF' : '';
    const blob = new Blob([bom + content], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  
  exportCurrent(kind: 'csv'|'json') {
    this.vm$.pipe(take(1)).subscribe(vm => {
      const data = this.flattenVm(vm);
      if (kind === 'csv') {
        const csv = this.toCsv(data);
        this.download('schedule-tasks.csv', csv, 'text/csv');
      } else {
        this.download('schedule-tasks.json', JSON.stringify(data, null, 2), 'application/json');
      }
    });
  }

}

