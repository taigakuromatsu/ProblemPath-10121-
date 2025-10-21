// src/app/pages/tree.page.ts
import { Component } from '@angular/core';
import { NgIf, AsyncPipe } from '@angular/common';

import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { AuthService } from '../services/auth.service';

import { MatButtonModule } from '@angular/material/button';
import { MatTreeNestedDataSource } from '@angular/material/tree';
import { NestedTreeControl } from '@angular/cdk/tree';
import { MatTreeModule } from '@angular/material/tree';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { NgChartsModule } from 'ng2-charts';
import { ChartConfiguration } from 'chart.js';

import { Observable, combineLatest, of } from 'rxjs';
import { map, switchMap, take, tap } from 'rxjs/operators';

type Status = 'not_started' | 'in_progress' | 'done';

type TreeNode = {
  id: string;
  name: string;
  kind: 'problem' | 'issue' | 'task';
  status?: Status;
  parentId?: string;            // issue の親 problemId
  parentIssueId?: string;       // task の親 issueId
  parentProblemId?: string;     // task の親 problemId
  children?: TreeNode[];
};

// tree.page.ts
const DEBUG_TREE = false; // ← 必要なときだけ true に

function dlog(...args: any[]) {
  if (DEBUG_TREE) console.debug(...args);
}


@Component({
  standalone: true,
  selector: 'pp-tree',
  imports: [NgIf, AsyncPipe, MatButtonModule, MatTreeModule, MatIconModule, MatTooltipModule, NgChartsModule],
  template: `
    <h3>Problems</h3>

    <div style="display:flex; align-items:center; gap:12px; margin:8px 0;">
      <span style="flex:1 1 auto;"></span>
      <ng-container *ngIf="auth.loggedIn$ | async; else signinT">
        <span style="opacity:.8; margin-right:6px;">{{ (auth.displayName$ | async) || 'signed in' }}</span>
        <button mat-stroked-button type="button" (click)="auth.signOut()">Sign out</button>
      </ng-container>
      <ng-template #signinT>
        <button mat-raised-button color="primary" type="button" (click)="auth.signInWithGoogle()">Sign in</button>
      </ng-template>
    </div>

    <!-- ===== Dashboard（集計＋グラフ） ===== -->
    <div style="display:flex; align-items:center; gap:8px; margin:8px 0 12px;">
      <button mat-stroked-button type="button" (click)="showDash = !showDash">
        {{ showDash ? 'Hide Dashboard' : 'Show Dashboard' }}
      </button>
    </div>

    <div *ngIf="showDash && (dash$ | async) as d"
         style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:12px; margin-bottom:12px;">

      <!-- 左：円グラフ -->
      <div style="border:1px solid #e5e7eb; border-radius:10px; padding:8px;">
        <div style="font-weight:600; margin-bottom:6px; font-size:13px;">Overall Status</div>
        <div style="height:180px;">
          <canvas baseChart
            [type]="'doughnut'"
            [data]="doughnutData(d.openTotal, d.doneTotal)"
            [options]="doughnutOptions">
          </canvas>
        </div>
        <div style="display:flex; gap:10px; margin-top:6px; font-size:12px; opacity:.8;">
          <span>Open: {{ d.openTotal }}</span>
          <span>Done: {{ d.doneTotal }}</span>
          <span>Total: {{ d.openTotal + d.doneTotal }}</span>
          <span>Progress: {{ d.progressPct }}%</span>
        </div>
      </div>

      <!-- 右：棒グラフ -->
      <div style="border:1px solid #e5e7eb; border-radius:10px; padding:8px;">
        <div style="font-weight:600; margin-bottom:6px; font-size:13px;">Open Tasks by Due</div>
        <div style="height:200px;">
          <canvas baseChart
            [type]="'bar'"
            [data]="barData(d)"
            [options]="barOptions">
          </canvas>
        </div>
        <div style="display:flex; gap:10px; margin-top:6px; font-size:12px; opacity:.8;">
          <span>Overdue: {{ d.overdue }}</span>
          <span>Today: {{ d.today }}</span>
          <span>This week: {{ d.thisWeek }}</span>
          <span>No due: {{ d.nodue }}</span>
        </div>
      </div>
    </div>
    <!-- ===== /Dashboard ===== -->

    <!-- エラー表示＆再試行 -->
    <div *ngIf="loadError" style="padding:8px 12px; border:1px solid #f44336; background:#ffebee; color:#b71c1c; border-radius:6px; margin:8px 0;">
      {{ loadError }}
      <button mat-button color="warn" type="button" (click)="retryProblems()" style="margin-left:8px;">
        再試行
      </button>
    </div>

    <mat-tree [dataSource]="dataSource" [treeControl]="tree" class="mat-elevation-z1">

      <!-- Problem（親） -->
      <mat-nested-tree-node *matTreeNodeDef="let node; when: isProblem">
        <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid rgba(0,0,0,.06);">
          <button mat-icon-button matTreeNodeToggle [disabled]="!(node.children?.length)">
            <mat-icon>{{ tree.isExpanded(node) ? 'expand_more' : 'chevron_right' }}</mat-icon>
          </button>
          <span style="font-weight:600">{{ node.name }}</span>
          <span style="flex:1 1 auto"></span>
          <button mat-button type="button" (click)="renameProblemNode(node)" *ngIf="auth.loggedIn$ | async">Rename</button>
          <button mat-button type="button" color="warn" (click)="removeProblemNode(node)" *ngIf="auth.loggedIn$ | async">Delete</button>
        </div>
        <div *ngIf="tree.isExpanded(node)"><ng-container matTreeNodeOutlet></ng-container></div>
      </mat-nested-tree-node>

      <!-- Issue（中間） -->
      <mat-nested-tree-node *matTreeNodeDef="let node; when: isIssue">
        <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid rgba(0,0,0,.06); margin-left:24px;">
          <button mat-icon-button matTreeNodeToggle [disabled]="!(node.children?.length)">
            <mat-icon>{{ tree.isExpanded(node) ? 'expand_more' : 'chevron_right' }}</mat-icon>
          </button>
          <span>{{ node.name }}</span>
          <span style="flex:1 1 auto"></span>
          <button mat-button type="button" (click)="renameIssueNode(node)" *ngIf="auth.loggedIn$ | async">Rename</button>
          <button mat-button type="button" color="warn" (click)="removeIssueNode(node)" *ngIf="auth.loggedIn$ | async">Delete</button>
        </div>
        <div *ngIf="tree.isExpanded(node)"><ng-container matTreeNodeOutlet></ng-container></div>
      </mat-nested-tree-node>

      <!-- Task（葉） -->
      <mat-nested-tree-node *matTreeNodeDef="let node">
        <div style="display:flex; align-items:center; gap:8px; padding:6px 8px;
                    border-bottom:1px solid rgba(0,0,0,.06); margin-left:56px;
                    border-left:4px solid {{ statusColor(node.status) }};">
          <button mat-icon-button disabled><mat-icon>task_alt</mat-icon></button>
          <span style="display:flex; align-items:center; gap:6px; max-width: 520px;">
            <span [style.color]="statusColor(node.status)"
                  matTooltip="{{ node.status==='done' ? '完了' : node.status==='in_progress' ? '対応中' : '未着手' }}">
              {{ statusIcon(node.status) }}
            </span>
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto;"
                  [matTooltip]="node.name">
              {{ node.name }}
            </span>
          </span>

          <span style="flex:1 1 auto"></span>
          <button mat-button type="button" (click)="renameTaskNode(node)" *ngIf="auth.loggedIn$ | async">Rename</button>
          <button mat-button type="button" color="warn" (click)="removeTaskNode(node)" *ngIf="auth.loggedIn$ | async">Delete</button>
        </div>
      </mat-nested-tree-node>

    </mat-tree>
  `
})
export class TreePage {

  // 表示ユーティリティ
  statusIcon(s?: Status) {
    if (s === 'done') return '✅';
    if (s === 'in_progress') return '🔼';
    return '✕';
  }
  statusColor(s?: Status) {
    if (s === 'done') return '#16a34a';
    if (s === 'in_progress') return '#2563eb';
    return '#dc2626';
  }

  busyIds = new Set<string>();
  isBusyId(id?: string|null){ return !!id && this.busyIds.has(id); }

  private decideAggregateStatus(taskStatuses: Status[]): Status {
    if (!taskStatuses.length) return 'not_started';
    if (taskStatuses.some(s => s === 'in_progress')) return 'in_progress';
    if (taskStatuses.every(s => s === 'done')) return 'done';
    return 'not_started';
  }

  private recomputeProblemStatus(problemId: string) {
    const pIdx = this.data.findIndex(p => p.id === problemId);
    if (pIdx === -1) return;

    const issueStatuses = (this.data[pIdx].children ?? [])
      .map(i => i.status)
      .filter((s): s is Status => !!s);

    const pStatus = this.decideAggregateStatus(issueStatuses);
    const newProblem = { ...this.data[pIdx], status: pStatus };
    this.data = [
      ...this.data.slice(0, pIdx),
      newProblem,
      ...this.data.slice(pIdx + 1)
    ];
    this.tree.dataNodes = [...this.data];
    this.dataSource.data = [...this.data];
  }

  isLoadingProblems = true;
  loadError: string | null = null;

  // MatTreeのノード操作（CRUDはすべてpid明示）
  constructor(
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    public auth: AuthService,
    private currentProject: CurrentProjectService
  ) {}

  renameProblemNode(node: { id: string; name: string }) {
    const t = prompt('New Problem title', node.name);
    if (!t?.trim()) return;
    this.withPid(pid => this.problems.update(pid, node.id, { title: t.trim() }));
  }
  removeProblemNode(node: { id: string; name: string }) {
    if (!confirm(`Delete "${node.name}"?`)) return;
    this.withPid(pid => this.problems.remove(pid, node.id));
  }

  renameIssueNode(node: { id: string; name: string; parentId?: string }) {
    if (!node.parentId) return;
    const t = prompt('New Issue title', node.name);
    if (!t?.trim()) return;
    this.withPid(pid => this.issues.update(pid, node.parentId!, node.id, { title: t.trim() }));
  }
  removeIssueNode(node: { id: string; name: string; parentId?: string }) {
    if (!node.parentId) return;
    if (!confirm(`Delete Issue "${node.name}"?`)) return;
    this.withPid(pid => this.issues.remove(pid, node.parentId!, node.id));
  }

  renameTaskNode(node: { id: string; name: string; parentProblemId?: string; parentIssueId?: string }) {
    if (!node.parentProblemId || !node.parentIssueId) return;
    const t = prompt('New Task title', node.name);
    if (!t?.trim()) return;
    this.withPid(pid => this.tasks.update(pid, node.parentProblemId!, node.parentIssueId!, node.id, { title: t.trim() }));
  }
  async removeTaskNode(node: { id: string; name: string; parentProblemId?: string; parentIssueId?: string }) {
    if (!node.parentProblemId || !node.parentIssueId || this.isBusyId(node.id)) return;
    if (!confirm(`Delete Task "${node.name}"?`)) return;
    this.busyIds.add(node.id!);
    this.withPid(async pid => {
      try { await this.tasks.remove(pid, node.parentProblemId!, node.parentIssueId!, node.id!); }
      finally { this.busyIds.delete(node.id!); }
    });
  }

  data: TreeNode[] = [];
  tree = new NestedTreeControl<TreeNode>(n => n.children ?? []);
  private subForTree?: import('rxjs').Subscription;

  private issueSubs = new Map<string, import('rxjs').Subscription>(); // problemId -> sub
  private taskSubs  = new Map<string, import('rxjs').Subscription>(); // `${problemId}_${issueId}` -> sub

    ngOnInit() {
       this.startProblemsSubscription();
        this.dash$ = this.buildDash$();
    }


  private startProblemsSubscription() {
    this.isLoadingProblems = true;
    this.loadError = null;

    this.subForTree?.unsubscribe();
    this.subForTree = combineLatest([this.currentProject.projectId$, this.auth.loggedIn$]).pipe(
      tap(([pid, isIn]) => dlog('[Tree] subscribe Problems with', { pid, isIn })),
      // ★ default は購読しない（実pidになるまで空配列）
      switchMap(([pid, isIn]) => {
        const safePid = (pid && pid !== 'default') ? pid : null;
        return (isIn && safePid) ? this.problems.list(safePid) : of([]);
      })
    ).subscribe({
      next: rows => {
        this.data = rows.map(r => ({
          id: r.id!,
          name: r.title,
          kind: 'problem',
          status: 'not_started',
          children: [] as TreeNode[]
        }));

        this.tree.dataNodes = [...this.data];
        this.dataSource.data = [...this.data];

        // Issue購読を貼り直し
        this.issueSubs.forEach(s => s.unsubscribe());
        this.issueSubs.clear();
        for (const p of this.data) this.attachIssueSubscription(p);

        this.isLoadingProblems = false;
        this.loadError = null;
      },
      error: (err) => {
        console.error('problems subscribe error', err);
        this.isLoadingProblems = false;
        this.loadError = err?.message ?? '読み込みに失敗しました';
      }
    });
  }

  retryProblems() { this.startProblemsSubscription(); }

  ngOnDestroy() {
    this.subForTree?.unsubscribe();
    this.issueSubs.forEach(s => s.unsubscribe());
    this.taskSubs.forEach(s => s.unsubscribe());
  }

  dataSource = new MatTreeNestedDataSource<TreeNode>();
  isProblem = (_: number, node: TreeNode) => node.kind === 'problem';
  isIssue   = (_: number, node: TreeNode) => node.kind === 'issue';

  private attachIssueSubscription(pNode: TreeNode) {
    this.issueSubs.get(pNode.id)?.unsubscribe();

    const sub = combineLatest([this.currentProject.projectId$, this.auth.loggedIn$]).pipe(
      tap(([pid, isIn]) => dlog('[Tree] subscribe Issues with', { pid, isIn, problemId: pNode.id })),
      switchMap(([pid, isIn]) => {
        const safePid = (pid && pid !== 'default') ? pid : null;
        return (isIn && safePid) ? this.issues.listByProblem(safePid, pNode.id) : of([]);
      })
    ).subscribe(issues => {
      const kids: TreeNode[] = issues.map(i => ({
        id: i.id!,
        name: i.title,
        kind: 'issue',
        parentId: pNode.id,
        status: 'not_started'
      }));

      // 古い Task 購読の掃除（この Problem 配下で、今ない Issue のもの）
      const aliveKeys = new Set(kids.map(k => `${pNode.id}_${k.id}`));
      for (const [k, s] of this.taskSubs.entries()) {
        if (k.startsWith(pNode.id + '_') && !aliveKeys.has(k)) {
          s.unsubscribe();
          this.taskSubs.delete(k);
        }
      }

      // 親ノードを参照ごと置換
      const pIdx = this.data.findIndex(n => n.id === pNode.id);
      if (pIdx !== -1) {
        const newNode: TreeNode = { ...this.data[pIdx], children: kids };
        this.data = [
          ...this.data.slice(0, pIdx),
          newNode,
          ...this.data.slice(pIdx + 1)
        ];
      }

      this.tree.dataNodes = [...this.data];
      this.dataSource.data = [...this.data];

      this.recomputeProblemStatus(pNode.id);

      // 各 Issue に Task 購読
      for (const issueNode of kids) this.attachTaskSubscription(pNode.id, issueNode);
    });

    this.issueSubs.set(pNode.id, sub);
  }

  private attachTaskSubscription(problemId: string, issueNode: TreeNode) {
    const key = `${problemId}_${issueNode.id}`;
    this.taskSubs.get(key)?.unsubscribe();

    const sub = combineLatest([this.currentProject.projectId$, this.auth.loggedIn$]).pipe(
      tap(([pid, isIn]) => dlog('[Tree] subscribe Tasks with', { pid, isIn, problemId, issueId: issueNode.id })),
      switchMap(([pid, isIn]) => {
        const safePid = (pid && pid !== 'default') ? pid : null;
        return (isIn && safePid) ? this.tasks.listByIssue(safePid, problemId, issueNode.id) : of([]);
      })
    ).subscribe(tasks => {
      const kids: TreeNode[] = tasks.map(t => ({
        id: t.id!,
        name: t.title,
        kind: 'task',
        status: (t.status as Status) ?? 'not_started',
        parentIssueId: issueNode.id,
        parentProblemId: problemId
      }));

      const pIdx = this.data.findIndex(p => p.id === problemId);
      if (pIdx !== -1) {
        const iIdx = this.data[pIdx].children?.findIndex(i => i.id === issueNode.id) ?? -1;
        if (iIdx !== -1) {
          const issueTaskStatuses = kids.map(k => k.status!).filter(Boolean) as Status[];
          const issueStatus = this.decideAggregateStatus(issueTaskStatuses);

          const newIssue = { ...this.data[pIdx].children![iIdx], children: kids, status: issueStatus };
          const newProblems = [...this.data];
          const newIssues = [
            ...newProblems[pIdx].children!.slice(0, iIdx),
            newIssue,
            ...newProblems[pIdx].children!.slice(iIdx + 1)
          ];
          newProblems[pIdx] = { ...newProblems[pIdx], children: newIssues };
          this.data = newProblems;

          this.tree.dataNodes = [...this.data];
          this.dataSource.data = [...this.data];

          this.recomputeProblemStatus(problemId);
        }
      }
    });

    this.taskSubs.set(key, sub);
  }

  // --- Dashboard state ---
  showDash = false;
  dash$!: Observable<{
    overdue: number; today: number; thisWeek: number; nodue: number;
    openTotal: number; doneTotal: number; progressPct: number;
  }>;

  // Chart.js options（小さめ）
  doughnutOptions: ChartConfiguration<'doughnut'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: { boxWidth: 10, boxHeight: 10, font: { size: 10 } }
      }
    },
    layout: { padding: { top: 4, bottom: 4, left: 0, right: 0 } },
    cutout: '60%'
  };

  barOptions: ChartConfiguration<'bar'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    elements: { bar: { borderRadius: 4 } },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 }, grid: { lineWidth: 0.5 } }
    },
    layout: { padding: { top: 2, bottom: 2, left: 0, right: 0 } }
  };

  doughnutData(open: number, done: number) {
    return {
      labels: ['Open', 'Done'],
      datasets: [{ data: [open, done] }]
    } as ChartConfiguration<'doughnut'>['data'];
  }
  barData(d: { overdue: number; today: number; thisWeek: number; nodue: number; }) {
    return {
      labels: ['Overdue', 'Today', 'This week', 'No due'],
      datasets: [{ data: [d.overdue, d.today, d.thisWeek, d.nodue], maxBarThickness: 22 }]
    } as ChartConfiguration<'bar'>['data'];
  }

  // --- 日付ユーティリティ ---
  private ymd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  }
  private addDays(base: Date, n: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d;
  }

  // --- ダッシュボード（pidに追従）
  private buildDash$(): Observable<{
    overdue: number; today: number; thisWeek: number; nodue: number;
    openTotal: number; doneTotal: number; progressPct: number;
  }> {
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = this.addDays(today, 1);

    // 今週（月曜始まり）
    const dow = today.getDay(); // Sun=0
    const diffToMon = (dow === 0 ? -6 : 1 - dow);
    const startOfWeek = this.addDays(today, diffToMon);
    const endOfWeek   = this.addDays(startOfWeek, 6);

    return this.currentProject.projectId$.pipe(
      switchMap(pid => {
        if (!pid) return of({
          overdue: 0, today: 0, thisWeek: 0, nodue: 0,
          openTotal: 0, doneTotal: 0, progressPct: 0
        });

        const overdue$  = this.tasks.listAllOverdue(pid, this.ymd(today), true);
        const today$    = this.tasks.listAllByDueRange(pid, this.ymd(today), this.ymd(today), true);
        const thisWeek$ = this.tasks.listAllByDueRange(pid, this.ymd(tomorrow), this.ymd(endOfWeek), true);
        const nodue$    = this.tasks.listAllNoDue(pid, true);
        const all$      = this.tasks.listAllByDueRange(pid, '0000-01-01', '9999-12-31', false);

        return combineLatest([overdue$, today$, thisWeek$, nodue$, all$]).pipe(
          map(([ov, td, wk, nd, all]) => {
            const overdue = ov?.length ?? 0;
            const today   = td?.length ?? 0;
            const thisWeek= wk?.length ?? 0;
            const nodue   = nd?.length ?? 0;

            const total     = all?.length ?? 0;
            const doneTotal = (all ?? []).filter(t => t.status === 'done').length;
            const openTotal = total - doneTotal;
            const progressPct = total > 0 ? Math.round((doneTotal / total) * 100) : 0;

            return { overdue, today, thisWeek, nodue, openTotal, doneTotal, progressPct };
          })
        );
      })
    );
  }

  // ---- ヘルパー ----
  private withPid(run: (pid: string) => void) {
    this.currentProject.projectId$.pipe(take(1)).subscribe(pid => {
      if (!pid) { alert('プロジェクト未選択'); return; }
      run(pid);
    });
  }

}
