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

import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { tap, shareReplay } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DestroyRef } from '@angular/core';
import { CdkDrag, CdkDropList } from '@angular/cdk/drag-drop'

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
                    <div
                        cdkDropList
                        [cdkDropListData]="ts"
                        [cdkDropListConnectedTo]="listIds(i.id!)"
                        [id]="listId(col, i.id!)"
                        (cdkDropListDropped)="onListDrop($event, pid, i.id!)"
                          [cdkDropListEnterPredicate]="canEnter"
                          style="border:1px solid #e5e7eb; border-radius:10px; padding:8px; margin-bottom:10px; min-height:60px;
                                transition:border-color .15s ease;"
                          (cdkDropListEntered)="($event.container.element.nativeElement.style.borderColor = '#9ca3af')"
                          (cdkDropListExited)="($event.container.element.nativeElement.style.borderColor = '#e5e7eb')"
                        >
                          
                        <!-- Issueグループのヘッダ -->
                        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                        <div style="font-weight:600;">{{ i.title }}</div>
                        <span style="font-size:12px; opacity:.7;">{{ ts.length }} 件</span>
                        </div>

                        <!-- カード本体 -->
                        <div *ngFor="let t of ts; trackBy: trackTask"
                            cdkDrag
                            [cdkDragData]="{ task: t, issueId: i.id }"
                            [cdkDragDisabled]="isBusy(t.id!)"
                            [style.opacity]="isBusy(t.id!) ? 0.5 : 1"
                            style="border:1px solid #ddd; border-radius:8px; padding:8px; margin-bottom:6px;">
                        <ng-template cdkDragPreview>
                            <div style="border:1px solid #bbb; border-radius:8px; padding:8px; background:#fff;">
                            {{ t.title }}
                            </div>
                        </ng-template>
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

                        <!-- 空プレースホルダ（受け皿が可視化される） -->
                        <div *ngIf="ts.length === 0"
                            style="padding:8px; border:1px dashed #d1d5db; border-radius:8px; text-align:center; opacity:.6; min-height: 100px;">
                        ここにドロップ
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
  
  trackTask = (_: number, t: Task) => t.id;

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
    private route: ActivatedRoute,
    private destroyRef: DestroyRef
  ) {}

  
ngOnInit() {
    this.problems$ = this.problems.list();
  
    this.issues$ = this.selectedProblem$.pipe(
      switchMap(pid => {
        if (!pid) {
          // 全リセット
          this.taskCountSubs.forEach(s => s.unsubscribe());
          this.taskCountSubs.clear();
          this.tasksSnapshot = {};
          this.totals = { not_started: 0, in_progress: 0, done: 0 };
          return of([]);
        }
  
        const stream = this.issues.listByProblem(pid).pipe(
          tap(list => {
            // ★ tap内に移動（外側購読のライフサイクルに乗る）
            const aliveKeys = new Set(list.map(i => this.key(pid, i.id!)));
            for (const [k, sub] of this.taskCountSubs.entries()) {
              if (!aliveKeys.has(k)) {
                sub.unsubscribe();
                this.taskCountSubs.delete(k);
                delete this.tasksSnapshot[k];
              }
            }
            for (const i of list) {
              const k = this.key(pid, i.id!);
              if (!this.tasksMap[k]) {
                // ↓ shareReplay(1) で二重購読を防ぐ
                this.tasksMap[k] = this.tasks.listByIssue(pid, i.id!).pipe(shareReplay(1));
              }
              if (!this.taskCountSubs.has(k)) {
                const sub = this.tasksMap[k].subscribe(ts => {
                  this.tasksSnapshot[k] = ts ?? [];
                  this.recalcTotals();
                });
                this.taskCountSubs.set(k, sub);
              }
            }
            this.recalcTotals();
          })
        );
        return stream;
      })
    );
  
    // クエリパラメータ購読は破棄を自動化
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(m => {
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

// ある Issue に属する3列（not_started / in_progress / done）を接続
listIds(issueId: string): string[] {
    return (['not_started','in_progress','done'] as const).map(s => this.listId(s, issueId));
  }
  
  // 各リストの一意ID（onListDrop の parse 規則と一致させる）
  listId(status: 'not_started'|'in_progress'|'done', issueId: string): string {
    return `dl-${status}-${issueId}`;
  }  



  async onListDrop(
    ev: CdkDragDrop<Task[]>,
    problemId: string,
    issueId: string
  ) {
    // ID -> status を復元（dl-<status>-<issueId>）
    const parse = (id: string) => id.split('-')[1] as 'not_started'|'in_progress'|'done';
    const srcStatus  = parse(ev.previousContainer.id);
    const destStatus = parse(ev.container.id);
  
    // 配列を取得（cdkDropListData の参照）
    const src = ev.previousContainer.data ?? [];
    const dst = ev.container.data ?? [];
  
    // 同一リスト内＝並べ替えだけ
    if (ev.previousContainer === ev.container) {
      moveItemInArray(dst, ev.previousIndex, ev.currentIndex);
      await this.persistOrder(problemId, issueId, dst);   // 現在リストを 10,20,30... で保存
      return;
    }
  
    // 列間＝要素を移動（src -> dst）
    transferArrayItem(src, dst, ev.previousIndex, ev.currentIndex);
  
    // 移動した Task を取得
    const moved = dst[ev.currentIndex];
    if (!moved?.id || this.isBusy(moved.id)) return;
  
    // 進捗の自動連動（簡易）
    const progress = destStatus === 'done' ? 100 : destStatus === 'not_started' ? 0 : 50;
  
    // 1) まず moved の status + progress を更新
    this.busyTaskIds.add(moved.id);
    try {
      await this.tasks.update(problemId, issueId, moved.id, { status: destStatus, progress });
    } catch (e) {
      console.error(e);
      alert('ステータス更新に失敗しました');
    } finally {
      this.busyTaskIds.delete(moved.id);
    }
  
    // 2) 両リストの order を再採番して保存（10刻み）
    await Promise.all([
      this.persistOrder(problemId, issueId, src),
      this.persistOrder(problemId, issueId, dst),
    ]);
  }
  
  private async persistOrder(
    problemId: string,
    issueId: string,
    arr: Task[]
  ) {
    const updates = arr.map((t, idx) => ({ id: t.id!, order: (idx + 1) * 10 }));
    for (const u of updates) {
      if (!u.id || this.isBusy(u.id)) continue;
      this.busyTaskIds.add(u.id);
      try {
        await this.tasks.update(problemId, issueId, u.id, { order: u.order });
      } catch (e) {
        console.error(e);
        alert('順序の保存に失敗しました');
      } finally {
        this.busyTaskIds.delete(u.id);
      }
    }
  }

  ngOnDestroy() {
    this.taskCountSubs.forEach(s => s.unsubscribe());
    this.taskCountSubs.clear();
  }
  
  
// ドロップ可否（処理中タスクは不可）
canEnter = (drag: CdkDrag, _drop: CdkDropList) => {
    const data = drag?.data as { task: Task; issueId: string } | undefined;
    const id = data?.task?.id;
    return !!id && !this.isBusy(id);
  };
  

}
