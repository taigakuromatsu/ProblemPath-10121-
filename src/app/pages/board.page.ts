import { Component } from '@angular/core';
import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Observable, BehaviorSubject, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';

import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { Problem, Issue, Task } from '../models/types';

@Component({
  standalone: true,
  selector: 'pp-board',
  imports: [AsyncPipe, NgFor, NgIf, FormsModule, MatButtonModule, RouterLink],
  template: `
    <div style="display:flex; align-items:center; gap:12px; margin:8px 0 16px;">
  <a mat-stroked-button routerLink="/tree">← Treeへ</a>

  <!-- Problem選択 -->
  <label>
    Problem:
    <select [(ngModel)]="selectedProblemId" (ngModelChange)="onSelectProblem($event)">
      <option [ngValue]="null">-- 選択してください --</option>
      <option *ngFor="let p of (problems$ | async)" [ngValue]="p.id">{{ p.title }}</option>
    </select>
  </label>
</div>

<div *ngIf="!selectedProblemId" style="opacity:.7">Problemを選ぶとカンバンを表示します。</div>

<ng-container *ngIf="selectedProblemId as pid">
  <!-- Issues 読み込み状態 -->
  <div *ngIf="(issues$ | async) === null">Loading issues...</div>

  <div *ngIf="(issues$ | async) as issues">
    <div *ngIf="!issues.length" style="opacity:.7">（このProblemにIssueはありません）</div>

    <div *ngIf="issues.length" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px;">
      <div *ngFor="let col of statusCols" style="border:1px solid #eee; border-radius:10px; padding:10px; min-height:80px;">
        <div style="font-weight:600; margin-bottom:8px;">{{ statusLabel[col] }}</div>

        <!-- ★ 列内を Issue ごとにグループ表示 -->
        <ng-container *ngFor="let i of issues">
          <ng-container *ngIf="tasksMap[key(pid, i.id!)] | async as tasks">
            <ng-container *ngIf="tasksByStatus(tasks, col) as ts">
              <div *ngIf="ts.length > 0" style="border:1px solid #e5e7eb; border-radius:10px; padding:8px; margin-bottom:10px;">
                <!-- Issueグループのヘッダ -->
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                  <div style="font-weight:600;">{{ i.title }}</div>
                  <span style="font-size:12px; opacity:.7;">{{ ts.length }} 件</span>
                </div>

                <!-- カード本体 -->
                <div *ngFor="let t of ts" style="border:1px solid #ddd; border-radius:8px; padding:8px; margin-bottom:6px;">
                  <div>{{ t.title }}</div>
                  <div style="display:flex; gap:6px; margin-top:6px;">
                    <button mat-button *ngFor="let next of statusCols"
                            [disabled]="next===t.status"
                            (click)="setTaskStatus(pid, i.id!, t, next)">
                      {{ statusLabel[next] }}
                    </button>
                  </div>
                </div>
              </div>
            </ng-container>
          </ng-container>
        </ng-container>
      </div>
    </div>
  </div>
</ng-container>

  `
})
export class BoardPage {
  // 列定義（最小）
  statusCols = ['not_started','in_progress','done'] as const;
  statusLabel: Record<string,string> = {
    not_started:'未着手', in_progress:'対応中', done:'完了'
  };

  problems$!: Observable<Problem[]>;
  selectedProblemId: string | null = null;

  private selectedProblem$ = new BehaviorSubject<string | null>(null);
  issues$: Observable<Issue[] | null> = of(null); // null=Loading, []=Empty

  tasksMap: Record<string, Observable<Task[]>> = {};

  constructor(
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService
  ) {}

  ngOnInit() {
    // Problem一覧（order昇順）をそのまま利用
    this.problems$ = this.problems.list();

    // Problem選択時に Issues を購読し直す
    this.issues$ = this.selectedProblem$.pipe(
      switchMap(pid => {
        if (!pid) return of([]);
        const stream = this.issues.listByProblem(pid);
        // Issuesが届くたび、そのIssueごとに Tasks の購読を確保
        stream.subscribe(list => {
          for (const i of list) {
            const k = this.key(pid, i.id!);
            if (!this.tasksMap[k]) {
              this.tasksMap[k] = this.tasks.listByIssue(pid, i.id!);
            }
          }
        });
        return stream;
      })
    );
  }

  onSelectProblem(pid: string | null) {
    this.selectedProblemId = pid;
    this.selectedProblem$.next(pid);
  }

  key(problemId: string, issueId: string) { return `${problemId}_${issueId}`; }

  async setTaskStatus(
    problemId: string,
    issueId: string,
    t: Task,
    status: 'not_started'|'in_progress'|'done'
  ) {
    const progress = status === 'done' ? 100 : status === 'not_started' ? 0 : 50;
    await this.tasks.update(problemId, issueId, t.id!, { status, progress });
  }

  tasksByStatus(tasks: Task[] | null | undefined, status: 'not_started'|'in_progress'|'done'): Task[] {
    return (tasks ?? []).filter(t => t.status === status);
  }  



}
