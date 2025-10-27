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
import { Firestore } from '@angular/fire/firestore';
import { doc, getDoc, collection, getDocs } from 'firebase/firestore';
import { TranslateModule } from '@ngx-translate/core'; // ★ 追加

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
  imports: [NgIf, RouterLink, MatButtonModule, MatIconModule, MatTooltipModule, TranslateModule],
  template: `
  <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid #e5e7eb; border-radius:8px; margin-bottom:6px;">
    <span [style.opacity]="t.status==='done' ? .6 : 1" style="flex:1 1 auto;">
      <strong>{{ t.title }}</strong>
      <span *ngIf="t.priority" style="font-size:12px; margin-left:6px; opacity:.8;">[{{ t.priority }}]</span>
      <span *ngIf="t.dueDate" style="font-size:12px; margin-left:8px; opacity:.8;">
        {{ 'task.dueShort' | translate:{ date: t.dueDate } }}
      </span>
    </span>

    <!-- Boardへ（problemId/issueId がある場合だけリンク） -->
    <a *ngIf="t.problemId && t.issueId"
       mat-stroked-button
       [routerLink]="['/board']"
       [queryParams]="{ pid: t.problemId }"
       [matTooltip]="'schedule.openInBoard' | translate">
       {{ 'nav.board' | translate }}
    </a>
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
    RouterLink, ScheduleRow, TranslateModule
  ],
  template: `
  <div style="display:flex; align-items:center; gap:12px; margin:8px 0 16px;">
    <a mat-stroked-button routerLink="/tree">← {{ 'nav.tree' | translate }}</a>
    <h3 style="margin:0;">{{ 'nav.schedule' | translate }}</h3>
    <span style="flex:1 1 auto;"></span>

    <button mat-stroked-button (click)="exportCurrent('csv')">{{ 'schedule.export.csv' | translate }}</button>
    <button mat-stroked-button style="margin-left:6px;" (click)="exportCurrent('json')">{{ 'schedule.export.json' | translate }}</button>

    <label>{{ 'schedule.view.label' | translate }}:
      <select [(ngModel)]="openOnly" (ngModelChange)="reload()">
        <option [ngValue]="true">{{ 'schedule.view.onlyOpen' | translate }}</option>
        <option [ngValue]="false">{{ 'schedule.view.all' | translate }}</option>
      </select>
    </label>

    <label style="margin-left:8px;">{{ 'schedule.tags.label' | translate }}:
      <input
        [(ngModel)]="tagQuery"
        (ngModelChange)="reload()"
        [placeholder]="'schedule.tags.placeholder' | translate"
        style="padding:4px 8px; border:1px solid #e5e7eb; border-radius:6px;"/>
    </label>
  </div>

  <ng-container *ngIf="vm$ | async as vm">
    <section>
      <h4 style="margin:12px 0;">⚠️ {{ 'schedule.section.overdue' | translate }}（{{ vm.overdue.length }}）</h4>
      <div *ngIf="!vm.overdue.length" style="opacity:.6">（{{ 'schedule.none' | translate }}）</div>
      <ul><li *ngFor="let t of vm.overdue; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">📅 {{ 'schedule.section.today' | translate }}（{{ vm.today.length }}）</h4>
      <div *ngIf="!vm.today.length" style="opacity:.6">（{{ 'schedule.none' | translate }}）</div>
      <ul><li *ngFor="let t of vm.today; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">🗓 {{ 'schedule.section.tomorrow' | translate }}（{{ vm.tomorrow.length }}）</h4>
      <div *ngIf="!vm.tomorrow.length" style="opacity:.6">（{{ 'schedule.none' | translate }}）</div>
      <ul><li *ngFor="let t of vm.tomorrow; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">🗓 {{ 'schedule.section.thisWeekRest' | translate }}（{{ vm.thisWeekRest.length }}）</h4>
      <div *ngIf="!vm.thisWeekRest.length" style="opacity:.6">（{{ 'schedule.none' | translate }}）</div>
      <ul><li *ngFor="let t of vm.thisWeekRest; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">🗓 {{ 'schedule.section.nextWeek' | translate }}（{{ vm.nextWeek.length }}）</h4>
      <div *ngIf="!vm.nextWeek.length" style="opacity:.6">（{{ 'schedule.none' | translate }}）</div>
      <ul><li *ngFor="let t of vm.nextWeek; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">📆 {{ 'schedule.section.later' | translate }}（{{ vm.later.length }}）</h4>
      <div *ngIf="!vm.later.length" style="opacity:.6">（{{ 'schedule.none' | translate }}）</div>
      <ul><li *ngFor="let t of vm.later; trackBy: trackTask"><pp-schedule-row [t]="t"></pp-schedule-row></li></ul>
    </section>

    <section>
      <h4 style="margin:12px 0;">— {{ 'schedule.section.noDue' | translate }}（{{ vm.nodue.length }}）</h4>
      <div *ngIf="!vm.nodue.length" style="opacity:.6">（{{ 'schedule.none' | translate }}）</div>
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
    private currentProject: CurrentProjectService,
    private fs: Firestore
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

    const FAR_FUTURE = '9999-12-31';
    const tags = this.parseTags(this.tagQuery);

    const params$ = of(null).pipe(startWith(null));

    this.vm$ = combineLatest([this.currentProject.projectId$, params$]).pipe(
      switchMap(([pid]) => {
        if (!pid) return of(EMPTY_VM);

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

  // --- CSV/JSON 出力（既存ロジックそのまま） ---
  private toCsv(tasks: Task[], nameMap: Map<string,string>, dir: Map<string,string>): string {
    const headers = ['ID','タイトル','状態','優先度','期日','担当者','プロジェクト','Problem','Issue','タグ','進捗(%)','作成日時','更新日時'];
    const esc = (v: any) => `"${(v ?? '').toString().replace(/"/g,'""')}"`;
    const fmtTs = (x: any) => {
      const d = x?.toDate?.() ?? (typeof x === 'string' ? new Date(x) : null);
      return d && !isNaN(d as any) ? new Date(d).toISOString().replace('T',' ').replace('Z','') : '';
    };
    const joinAssignees = (xs: any) =>
      Array.isArray(xs) ? xs.map((u: string) => dir.get(u) ?? u).join(', ') : (xs ?? '');

    const rows = tasks.map(t => {
      const pj = t.projectId ? (nameMap.get(`project:${t.projectId}`) ?? t.projectId) : '';
      const pr = (t.projectId && t.problemId) ? (nameMap.get(`problem:${t.projectId}:${t.problemId}`) ?? t.problemId) : '';
      const is = (t.projectId && t.problemId && t.issueId) ? (nameMap.get(`issue:${t.projectId}:${t.problemId}:${t.issueId}`) ?? t.issueId) : '';
      return [
        t.id,
        t.title,
        t.status,
        t.priority ?? '',
        t.dueDate ?? '',
        joinAssignees(t.assignees),
        pj, pr, is,
        Array.isArray(t.tags) ? t.tags.join(', ') : (t.tags ?? ''),
        (t as any).progress ?? '',
        fmtTs((t as any).createdAt),
        fmtTs((t as any).updatedAt),
      ].map(esc).join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  private toJson(tasks: Task[], nameMap: Map<string,string>, dir: Map<string,string>): string {
    const mapped = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority ?? null,
      dueDate: t.dueDate ?? null,
      assignees: Array.isArray(t.assignees) ? t.assignees.map(u => dir.get(u) ?? u) : [],
      project: t.projectId ? (nameMap.get(`project:${t.projectId}`) ?? t.projectId) : null,
      problem: (t.projectId && t.problemId) ? (nameMap.get(`problem:${t.projectId}:${t.problemId}`) ?? t.problemId) : null,
      issue: (t.projectId && t.problemId && t.issueId) ? (nameMap.get(`issue:${t.projectId}:${t.problemId}:${t.issueId}`) ?? t.issueId) : null,
      tags: t.tags ?? [],
      progress: (t as any).progress ?? null,
      createdAt: (t as any).createdAt?.toDate?.() ?? null,
      updatedAt: (t as any).updatedAt?.toDate?.() ?? null,
      projectId: t.projectId ?? null,
      problemId: t.problemId ?? null,
      issueId: t.issueId ?? null,
    }));
    return JSON.stringify(mapped, null, 2);
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
    this.vm$.pipe(take(1)).subscribe(async vm => {
      const data = this.flattenVm(vm);
      const nameMap = await this.resolveNames(data);
      const assigneeDir = await this.resolveAssigneeDirectory(data);
      if (kind === 'csv') {
        const csv = this.toCsv(data, nameMap, assigneeDir);
        this.download('schedule-tasks.csv', csv, 'text/csv');
      } else {
        const json = this.toJson(data, nameMap, assigneeDir);
        this.download('schedule-tasks.json', json, 'application/json');
      }
    });
  }

  private async resolveNames(tasks: Task[]): Promise<Map<string, string>> {
    const nameMap = new Map<string,string>();
    const needProject = new Set<string>();
    const needProblem: Array<{pid:string; problemId:string}> = [];
    const needIssue: Array<{pid:string; problemId:string; issueId:string}> = [];

    for (const t of tasks) {
      if (t.projectId) needProject.add(t.projectId);
      if (t.projectId && t.problemId) needProblem.push({ pid: t.projectId, problemId: t.problemId });
      if (t.projectId && t.problemId && t.issueId) needIssue.push({ pid: t.projectId, problemId: t.problemId, issueId: t.issueId });
    }

    await Promise.all(Array.from(needProject).map(async pid => {
      const snap = await getDoc(doc(this.fs as any, `projects/${pid}`));
      const name = snap.exists() ? (snap.data() as any)?.meta?.name ?? pid : pid;
      nameMap.set(`project:${pid}`, name);
    }));

    await Promise.all(needProblem.map(async x => {
      const key = `problem:${x.pid}:${x.problemId}`;
      if (nameMap.has(key)) return;
      const snap = await getDoc(doc(this.fs as any, `projects/${x.pid}/problems/${x.problemId}`));
      const title = snap.exists() ? (snap.data() as any)?.title ?? x.problemId : x.problemId;
      nameMap.set(key, title);
    }));

    await Promise.all(needIssue.map(async x => {
      const key = `issue:${x.pid}:${x.problemId}:${x.issueId}`;
      if (nameMap.has(key)) return;
      const snap = await getDoc(doc(this.fs as any, `projects/${x.pid}/problems/${x.problemId}/issues/${x.issueId}`));
      const title = snap.exists() ? (snap.data() as any)?.title ?? x.issueId : x.issueId;
      nameMap.set(key, title);
    }));

    return nameMap;
  }

  private async resolveAssigneeDirectory(tasks: Task[]): Promise<Map<string,string>> {
    const byUid = new Map<string,string>();
    const pids = Array.from(new Set(tasks.map(t => t.projectId).filter(Boolean))) as string[];

    for (const pid of pids) {
      const col = collection(this.fs as any, `projects/${pid}/members`);
      const snap = await getDocs(col);
      snap.forEach(docSnap => {
        const d: any = docSnap.data();
        const label = d?.displayName || d?.email || docSnap.id;
        byUid.set(docSnap.id, label);
      });
    }
    return byUid;
  }
}


