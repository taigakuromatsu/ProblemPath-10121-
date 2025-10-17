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
              <div style="font-weight:600; margin-bottom:8px;">{{ statusLabel[col] }}</div>
  
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
                           style="border:1px solid #ddd; border-radius:8px; padding:8px; margin-bottom:6px;">
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
    private tasks: TasksService,
    private router: Router,
    private route: ActivatedRoute
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
        // URLの ?pid=... を監視して選択状態に反映
        this.route.queryParamMap.subscribe((m) => {
            const pid = m.get('pid');
            this.selectedProblemId = pid;
            this.selectedProblem$.next(pid);
        });

  }

  onSelectProblem(pid: string | null) {
    this.selectedProblemId = pid;
    this.selectedProblem$.next(pid);
    // ★ URLにも反映（他のクエリは維持）
    this.router.navigate([], { queryParams: { pid }, queryParamsHandling: 'merge' });
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


  // ★ 列DropListのID一覧（list-not_started / list-in_progress / list-done）
dropIds = (['not_started','in_progress','done'] as const).map(s => `list-${s}`);

// ★ ドロップ時：列間移動なら status を更新（列内は今回はスキップ）
async onDrop(ev: CdkDragDrop<any>, problemId: string) {
  // 同じ列内のドロップは今回は何もしない（order対応は後段）
  if (ev.previousContainer === ev.container) return;

  // 目的列の status をIDから復元
  const dest = ev.container.id.replace('list-','') as 'not_started'|'in_progress'|'done';

  // ドラッグされたタスク情報
  const data = ev.item.data as { task: Task; issueId: string };

  // progress の自動連動（簡易）
  const progress = dest === 'done' ? 100 : dest === 'not_started' ? 0 : 50;

  // 更新
  await this.tasks.update(problemId, data.issueId, data.task.id!, { status: dest, progress });
}



}
