// src/app/pages/my-tasks.page.ts
import { Component, Input } from '@angular/core';
import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { Observable, combineLatest, of } from 'rxjs';
import { map, switchMap, startWith } from 'rxjs/operators';

import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { AuthService } from '../services/auth.service';
import { Task } from '../models/types';

type Vm = {
  overdue: Task[]; today: Task[]; tomorrow: Task[];
  thisWeekRest: Task[]; nextWeek: Task[]; later: Task[]; nodue: Task[];
};
const EMPTY: Vm = { overdue:[], today:[], tomorrow:[], thisWeekRest:[], nextWeek:[], later:[], nodue:[] };

/** 行アイテム（簡易） */
@Component({
  standalone: true,
  selector: 'pp-item',
  imports: [NgIf, RouterLink, MatButtonModule, MatIconModule],
  template: `
    <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid #e5e7eb; border-radius:8px; margin-bottom:6px;">
      <span [style.opacity]="t.status==='done' ? .6 : 1" style="flex:1 1 auto;">
        <strong>{{ t.title }}</strong>
        <span *ngIf="t.priority" style="font-size:12px; margin-left:6px; opacity:.8;">[{{ t.priority }}]</span>
        <span *ngIf="t.dueDate" style="font-size:12px; margin-left:8px; opacity:.8;">due: {{ t.dueDate }}</span>
      </span>
      <a *ngIf="t.problemId && t.issueId" mat-stroked-button [routerLink]="['/board']" [queryParams]="{ pid: t.problemId }">Board</a>
    </div>
  `
})
export class MyItem {
  @Input() t!: Task; // ← Input を明示
}

@Component({
  standalone: true,
  selector: 'pp-my-tasks',
  imports: [
    AsyncPipe, NgFor, NgIf, FormsModule,
    MatButtonModule, MatSelectModule, MatIconModule, RouterLink,
    MyItem // ← 子コンポーネントを宣言
  ],
  template: `
  <div style="display:flex; align-items:center; gap:12px; margin:8px 0 16px;">
    <a mat-stroked-button routerLink="/tree">← Treeへ</a>
    <h3 style="margin:0;">My Tasks</h3>
    <span style="flex:1 1 auto;"></span>

    <label>表示:
      <select [(ngModel)]="openOnly" (ngModelChange)="reload()">
        <option [ngValue]="true">未完了のみ</option>
        <option [ngValue]="false">すべて</option>
      </select>
    </label>
    <label style="margin-left:8px;">タグ:
      <input [(ngModel)]="tagQuery" (ngModelChange)="reload()" placeholder="#bug #UI（スペース区切り）"
        style="padding:4px 8px; border:1px solid #e5e7eb; border-radius:6px;"/>
    </label>
  </div>

  <ng-container *ngIf="vm$ | async as vm">
    <section><h4>⚠️ 期限切れ（{{ vm.overdue.length }}）</h4>
      <div *ngIf="!vm.overdue.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.overdue; trackBy: track"><pp-item [t]="t"></pp-item></li></ul></section>
    <section><h4>📅 今日（{{ vm.today.length }}）</h4>
      <div *ngIf="!vm.today.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.today; trackBy: track"><pp-item [t]="t"></pp-item></li></ul></section>
    <section><h4>🗓 明日（{{ vm.tomorrow.length }}）</h4>
      <div *ngIf="!vm.tomorrow.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.tomorrow; trackBy: track"><pp-item [t]="t"></pp-item></li></ul></section>
    <section><h4>🗓 今週の残り（{{ vm.thisWeekRest.length }}）</h4>
      <div *ngIf="!vm.thisWeekRest.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.thisWeekRest; trackBy: track"><pp-item [t]="t"></pp-item></li></ul></section>
    <section><h4>🗓 来週（{{ vm.nextWeek.length }}）</h4>
      <div *ngIf="!vm.nextWeek.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.nextWeek; trackBy: track"><pp-item [t]="t"></pp-item></li></ul></section>
    <section><h4>📆 以降（{{ vm.later.length }}）</h4>
      <div *ngIf="!vm.later.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.later; trackBy: track"><pp-item [t]="t"></pp-item></li></ul></section>
    <section><h4>— 期限未設定（{{ vm.nodue.length }}）</h4>
      <div *ngIf="!vm.nodue.length" style="opacity:.6">（なし）</div>
      <ul><li *ngFor="let t of vm.nodue; trackBy: track"><pp-item [t]="t"></pp-item></li></ul></section>
  </ng-container>
  `
})
export class MyTasksPage {
  vm$: Observable<Vm> = of(EMPTY);
  openOnly = true;
  tagQuery = '';

  constructor(
    private tasks: TasksService,
    private current: CurrentProjectService,
    private auth: AuthService
  ) {}

  ngOnInit(){ this.reload(); }
  track = (_: number, t: Task) => t.id;

  private ymd(d: Date){ const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const da=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
  private addDays(base: Date, n: number){ const d = new Date(base); d.setDate(d.getDate()+n); return d; }
  private parseTags(q: string){ return (q||'').split(/\s+/).map(s=>s.replace(/^#/,'').trim()).filter(Boolean).slice(0,10); }

  reload(){
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = this.addDays(today, 1);
    const day = today.getDay(); const diffToMon = (day===0? -6 : 1-day);
    const startOfWeek = this.addDays(today, diffToMon);
    const endOfWeek = this.addDays(startOfWeek, 6);
    const startOfNextWeek = this.addDays(endOfWeek, 1);
    const endOfNextWeek = this.addDays(startOfNextWeek, 6);
    const far = '9999-12-31';
    const tags = this.parseTags(this.tagQuery);

    const trig$ = of(null).pipe(startWith(null));

    this.vm$ = combineLatest([this.current.projectId$, this.auth.uid$, trig$]).pipe(
      switchMap(([pid, uid]) => {
        if (!pid || !uid) return of(EMPTY);

        // 今日までの全件を一度取得して、そこで overdue/today を切り分ける
        const allToToday$ = this.tasks.listMine(
          pid, uid, this.openOnly, '0000-01-01', this.ymd(today), tags
        );

        const overdue$       = allToToday$.pipe(map(xs => xs.filter(x => (x.dueDate ?? '') <  this.ymd(today))));
        const today$         = allToToday$.pipe(map(xs => xs.filter(x => x.dueDate === this.ymd(today))));
        const tomorrow$      = this.tasks.listMine(pid, uid, this.openOnly, this.ymd(tomorrow), this.ymd(tomorrow), tags);
        const thisWeekRest$  = this.tasks.listMine(pid, uid, this.openOnly, this.ymd(this.addDays(tomorrow,1)), this.ymd(endOfWeek), tags);
        const nextWeek$      = this.tasks.listMine(pid, uid, this.openOnly, this.ymd(startOfNextWeek), this.ymd(endOfNextWeek), tags);
        const later$         = this.tasks.listMine(pid, uid, this.openOnly, this.ymd(this.addDays(endOfNextWeek,1)), far, tags);
        const nodue$ = this.tasks.listMineNoDue(pid, uid, this.openOnly, tags);

        return combineLatest([overdue$, today$, tomorrow$, thisWeekRest$, nextWeek$, later$, nodue$]).pipe(
          map(([overdue, today, tomorrow, thisWeekRest, nextWeek, later, nodue]) => ({
            overdue, today, tomorrow, thisWeekRest, nextWeek, later, nodue
          }))
        );
      })
    );
  }
}

