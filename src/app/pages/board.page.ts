import { Component } from '@angular/core';
import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable, BehaviorSubject, of } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';

import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { Problem, Issue, Task } from '../models/types';

import { DragDropModule, CdkDragDrop } from '@angular/cdk/drag-drop';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';


@Component({
    standalone: true,
    selector: 'pp-board',
    imports: [AsyncPipe, NgFor, NgIf, FormsModule, MatButtonModule, RouterLink, DragDropModule],
    template: `
      <div style="display:flex; align-items:center; gap:12px; margin:8px 0 16px;">
        <a mat-stroked-button routerLink="/tree">← Treeへ</a>
  
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
        <div *ngIf="(issues$ | async) === null">Loading issues...</div>
  
        <div *ngIf="(issues$ | async) as issues">
          <div *ngIf="!issues.length" style="opacity:.7">（このProblemにIssueはありません）</div>
  
          <div *ngIf="issues.length" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px;">
            <div
              *ngFor="let col of statusCols"
              style="border:1px solid #eee; border-radius:10px; padding:10px; min-height:80px;"
              cdkDropList
              [id]="'list-' + col"
              [cdkDropListConnectedTo]="dropIds"
              cdkDropListSortingDisabled="true"
              (cdkDropListDropped)="onDrop($event, pid)"
            >
              <div style="font-weight:600; margin-bottom:8px; display:flex; align-items:center; gap:8px;">
                <span>{{ statusLabel[col] }}</span>
                <span style="
                    display:inline-block; min-width:20px; padding:2px 6px;
                    font-size:12px; line-height:1; text-align:center;
                    border-radius:999px; border:1px solid #e5e7eb; background:#f8fafc;">
                    {{ totals[col] }}
                </span>
                </div>
  
              <!-- 列内を Issue ごとにグループ表示 -->
              <ng-container *ngFor="let i of issues">
                <ng-container *ngIf="tasksMap[key(pid, i.id!)] | async as tasks">
                  <ng-container *ngIf="tasksByStatus(tasks, col) as ts">
                    <div *ngIf="ts.length > 0" style="border:1px solid #e5e7eb; border-radius:10px; padding:8px; margin-bottom:10px;">
                      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                        <div style="font-weight:600;">{{ i.title }}</div>
                        <span style="font-size:12px; opacity:.7;">{{ ts.length }} 件</span>
                      </div>
  
                      <div *ngFor="let t of ts"
                            cdkDrag
                            [cdkDragData]="{ task: t, issueId: i.id }"
                            [cdkDragDisabled]="isBusy(t.id!)"
                            [style.opacity]="isBusy(t.id!) ? 0.5 : 1"
                            style="border:1px solid #ddd; border-radius:8px; padding:8px; margin-bottom:6px;">

                        <!-- ドラッグ時のプレビュー -->
                        <ng-template cdkDragPreview>
                            <div style="border:1px solid #bbb; border-radius:8px; padding:8px; background:#fff;">
                            {{ t.title }}
                            </div>
                        </ng-template>

                        <!-- プレースホルダ（空白を確保） -->
                        <ng-template cdkDragPlaceholder>
                            <div style="border:1px dashed #bbb; border-radius:8px; padding:8px; background:#fafafa;"></div>
                        </ng-template>

                        <div>{{ t.title }}</div>
                        <div style="display:flex; gap:6px; margin-top:6px;">
                            <button mat-button *ngFor="let next of statusCols"
                                    [disabled]="next===t.status || isBusy(t.id!)"
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


    // 列合計（未着手/対応中/完了）
totals: Record<'not_started'|'in_progress'|'done', number> = {
    not_started: 0, in_progress: 0, done: 0
  };
  
  // 集計用の購読・スナップショット（issueごとのTask一覧の最新を保持）
  private taskCountSubs = new Map<string, import('rxjs').Subscription>(); // key=pid_issueId
  private tasksSnapshot: Record<string, Task[]> = {};
  
  private recalcTotals() {
    const t = { not_started: 0, in_progress: 0, done: 0 } as Record<'not_started'|'in_progress'|'done', number>;
    for (const list of Object.values(this.tasksSnapshot)) {
      for (const x of list) {
        if (x.status === 'done') t.done++;
        else if (x.status === 'in_progress') t.in_progress++;
        else t.not_started++;
      }
    }
    this.totals = t;
  }
  

    // 同一タスクの多重操作を防ぐための処理中セット
busyTaskIds = new Set<string>();
isBusy(id: string | undefined | null): boolean {
  return !!id && this.busyTaskIds.has(id);
}


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
    private tasks: TasksService,
    private router: Router,
    private route: ActivatedRoute
  ) {}

  ngOnInit() {
    // Problem一覧（order昇順）をそのまま利用
    this.problems$ = this.problems.list();

    this.issues$ = this.selectedProblem$.pipe(
        switchMap(pid => {
          if (!pid) {
            // ★ 問題未選択時は全リセット
            this.taskCountSubs.forEach(s => s.unsubscribe());
            this.taskCountSubs.clear();
            this.tasksSnapshot = {};
            this.totals = { not_started: 0, in_progress: 0, done: 0 };
            return of([]);
          }
      
          const stream = this.issues.listByProblem(pid);
      
          // Issuesが届くたび、そのIssueごとに Tasks の購読を確保
          stream.subscribe(list => {
            // 1) 既存購読のうち、今回リストに含まれないものを掃除
            const aliveKeys = new Set(list.map(i => this.key(pid, i.id!)));
            for (const [k, sub] of this.taskCountSubs.entries()) {
              if (!aliveKeys.has(k)) {
                sub.unsubscribe();
                this.taskCountSubs.delete(k);
                delete this.tasksSnapshot[k];
              }
            }
      
            // 2) 各Issueの Task ストリーム購読を確保（未登録のみ）
            for (const i of list) {
              const k = this.key(pid, i.id!);
      
              if (!this.tasksMap[k]) {
                this.tasksMap[k] = this.tasks.listByIssue(pid, i.id!);
              }
      
              if (!this.taskCountSubs.has(k)) {
                const sub = this.tasks.listByIssue(pid, i.id!).subscribe(ts => {
                  this.tasksSnapshot[k] = ts ?? [];
                  this.recalcTotals();            // ★ 受信のたびに合計再計算
                });
                this.taskCountSubs.set(k, sub);
              }
            }
      
            // 3) 初回も一度集計を更新（空なら0のまま）
            this.recalcTotals();
          });
      
          return stream;
        })
      );
      

        // URLの ?pid=... を監視して選択状態に反映
        this.route.queryParamMap.subscribe((m) => {
            const pid = m.get('pid');
            this.selectedProblemId = pid;
            this.selectedProblem$.next(pid);
        });

  }

  onSelectProblem(pid: string | null) {
    // 任意: 先に全リセット（問題切替の瞬間に合計を0にしたい場合）
    this.taskCountSubs.forEach(s => s.unsubscribe());
    this.taskCountSubs.clear();
    this.tasksSnapshot = {};
    this.totals = { not_started: 0, in_progress: 0, done: 0 };
  
    this.selectedProblemId = pid;
    this.selectedProblem$.next(pid);
    this.router.navigate([], { queryParams: { pid }, queryParamsHandling: 'merge' });
  }  
  

  key(problemId: string, issueId: string) { return `${problemId}_${issueId}`; }

  async setTaskStatus(
    problemId: string,
    issueId: string,
    t: Task,
    status: 'not_started'|'in_progress'|'done'
  ) {
    if (!t.id || this.isBusy(t.id)) return;
    const progress = status === 'done' ? 100 : status === 'not_started' ? 0 : 50;
  
    this.busyTaskIds.add(t.id);
    try {
      await this.tasks.update(problemId, issueId, t.id, { status, progress });
    } catch (e) {
      console.error(e);
      alert('更新に失敗しました');
    } finally {
      this.busyTaskIds.delete(t.id);
    }
  }

  tasksByStatus(tasks: Task[] | null | undefined, status: 'not_started'|'in_progress'|'done'): Task[] {
    return (tasks ?? []).filter(t => t.status === status);
  }  


  // ★ 列DropListのID一覧（list-not_started / list-in_progress / list-done）
dropIds = (['not_started','in_progress','done'] as const).map(s => `list-${s}`);

async onDrop(ev: CdkDragDrop<any>, problemId: string) {
    // 同一列内は未対応（orderは後段）なのでスキップ
    if (ev.previousContainer === ev.container) return;
  
    const dest = ev.container.id.replace('list-','') as 'not_started'|'in_progress'|'done';
    const data = ev.item.data as { task: Task; issueId: string };
    const t = data.task;
  
    if (!t.id || this.isBusy(t.id)) return;
  
    const progress = dest === 'done' ? 100 : dest === 'not_started' ? 0 : 50;
  
    this.busyTaskIds.add(t.id);
    try {
      await this.tasks.update(problemId, data.issueId, t.id, { status: dest, progress });
    } catch (e) {
      console.error(e);
      alert('更新に失敗しました');
    } finally {
      this.busyTaskIds.delete(t.id);
    }
  }


}
