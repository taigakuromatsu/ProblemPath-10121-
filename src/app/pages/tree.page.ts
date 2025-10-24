// src/app/pages/tree.page.ts
import { Component } from '@angular/core';
import { NgIf, NgFor, AsyncPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

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

import { Observable, combineLatest, of, firstValueFrom } from 'rxjs';
import { map, switchMap, take, tap } from 'rxjs/operators';
import { MembersService } from '../services/members.service';
import { CommentsService, CommentDoc, CommentTarget } from '../services/comments.service';

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

const DEBUG_TREE = false; // ← 必要なときだけ true に
function dlog(...args: any[]) {
  if (DEBUG_TREE) console.debug(...args);
}

@Component({
  standalone: true,
  selector: 'pp-tree',
  imports: [
    NgIf, NgFor, AsyncPipe, DatePipe, FormsModule,
    MatButtonModule, MatTreeModule, MatIconModule, MatTooltipModule,
    NgChartsModule
  ],
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

    <!-- ===== Dashboard ===== -->
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
          <span>Next week: {{ d.nextWeek }}</span>
          <span>Later: {{ d.later }}</span>
          <span>No due: {{ d.nodue }}</span>
        </div>
      </div>
    </div>
    <!-- ===== /Dashboard ===== -->

    <!-- ===== 2カラム：左=ツリー / 右=コメントパネル ===== -->
    <div style="display:grid; grid-template-columns: 1fr 360px; gap:12px; align-items:start;">

      <!-- 左：ツリー -->
      <div>
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

              <!-- 💬 コメント（件数バッジ付き） -->
              <button mat-button type="button" (click)="openComments(node)">
                💬 Comments ({{ commentCounts[node.id] ?? 0 }})
              </button>

              <button mat-button type="button" (click)="renameProblemNode(node)" *ngIf="isEditor$ | async">Rename</button>
              <button mat-button type="button" color="warn" (click)="removeProblemNode(node)" *ngIf="isEditor$ | async">Delete</button>
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

              <!-- 💬 コメント（件数バッジ付き） -->
              <button mat-button type="button" (click)="openComments(node)">
                💬 Comments ({{ commentCounts[node.id] ?? 0 }})
              </button>

              <button mat-button type="button" (click)="renameIssueNode(node)" *ngIf="isEditor$ | async">Rename</button>
              <button mat-button type="button" color="warn" (click)="removeIssueNode(node)" *ngIf="isEditor$ | async">Delete</button>
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

              <!-- 💬 コメント（件数バッジ付き） -->
              <button mat-button type="button" (click)="openComments(node)">
                💬 Comments ({{ commentCounts[node.id] ?? 0 }})
              </button>

              <button mat-button type="button" (click)="renameTaskNode(node)" *ngIf="isEditor$ | async">Rename</button>
              <button mat-button type="button" color="warn" (click)="removeTaskNode(node)" *ngIf="isEditor$ | async">Delete</button>
            </div>
          </mat-nested-tree-node>

        </mat-tree>
      </div>

      <!-- 右：コメントパネル -->
      <aside style="border:1px solid #e5e7eb; border-radius:10px; padding:10px; position:sticky; top:12px; height:fit-content;">
        <div *ngIf="!selectedNode" style="opacity:.65;">左のツリーから対象を選んでコメントを表示</div>

        <ng-container *ngIf="selectedNode">
          <div style="font-weight:700; margin-bottom:8px;">
            💬 Comments — {{ selectedNode.kind }}: {{ selectedNode.name }}
          </div>

          <div style="display:flex; gap:6px; margin-bottom:8px;">
            <textarea [(ngModel)]="newBody" rows="3" style="flex:1; width:100%;"
                      placeholder="コメントを入力…"></textarea>
          </div>
          <div style="display:flex; gap:8px; margin-bottom:12px;">
            <button mat-raised-button color="primary" (click)="editingId ? saveEdit() : addComment()"
                    [disabled]="!newBody.trim()">
              {{ editingId ? '更新' : '投稿' }}
            </button>
            <button mat-stroked-button (click)="cancelEdit()" *ngIf="editingId">キャンセル</button>
          </div>

          <div *ngIf="comments$ | async as cs; else loadingC">
            <div *ngIf="!cs.length" style="opacity:.65;">まだコメントはありません</div>
            <div *ngFor="let c of cs" style="border-top:1px solid #eee; padding:8px 0;">
              <div style="font-size:12px; opacity:.75;">
                <span>{{ c.authorName || c.authorId }}</span> ・
                <span>{{ c.createdAt?.toDate?.() ? (c.createdAt.toDate() | date:'yyyy/MM/dd HH:mm') : '' }}</span>
              </div>
              <div style="white-space:pre-wrap;">{{ c.body }}</div>

              <div style="display:flex; gap:6px; margin-top:6px;"
                   *ngIf="(members.isAdmin$ | async) || ((auth.uid$ | async) === c.authorId)">
                <button mat-button (click)="startEdit(c.id!, c.body)">編集</button>
                <button mat-button color="warn" (click)="deleteComment(c.id!)">削除</button>
              </div>
            </div>
          </div>
          <ng-template #loadingC><div style="opacity:.65;">読み込み中…</div></ng-template>
        </ng-container>
      </aside>
    </div>
    <!-- ===== /2カラム ===== -->
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

  isEditor$!: Observable<boolean>;

  selectedNode: TreeNode | null = null;
  comments$?: Observable<CommentDoc[]>;
  newBody = '';
  editingId: string | null = null;

  // コメント件数バッジ（node.id -> count）
  commentCounts: Partial<Record<string, number>> = {};

  data: TreeNode[] = [];
  tree = new NestedTreeControl<TreeNode>(n => n.children ?? []);
  private subForTree?: import('rxjs').Subscription;

  private issueSubs = new Map<string, import('rxjs').Subscription>(); // problemId -> sub
  private taskSubs  = new Map<string, import('rxjs').Subscription>(); // `${problemId}_${issueId}` -> sub

  constructor(
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    public auth: AuthService,
    private currentProject: CurrentProjectService,
    public members: MembersService,
    private comments: CommentsService
  ) {
    this.isEditor$ = this.members.isEditor$;
  }

  // ===== あなたの現行メソッドを保持 =====
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
  // ===== /保持ここまで =====

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
      switchMap(([pid, isIn]) => {
        const safePid = (pid && pid !== 'default') ? pid : null;
        return (isIn && safePid) ? this.problems.list(safePid) : of([]);
      })
    ).subscribe({
      next: async rows => {
        this.data = rows.map(r => ({
          id: r.id!,
          name: r.title,
          kind: 'problem',
          status: 'not_started',
          children: [] as TreeNode[]
        }));

        this.tree.dataNodes = [...this.data];
        this.dataSource.data = [...this.data];

        // 件数をProblem単位で先にロード
        try {
          await Promise.all(this.data.map(n => this.loadCountFor(n)));
        } catch {}

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
    ).subscribe(async issues => {
      const kids: TreeNode[] = issues.map(i => ({
        id: i.id!,
        name: i.title,
        kind: 'issue',
        parentId: pNode.id,
        status: 'not_started'
      }));

      // 古い Task 購読の掃除
      const aliveKeys = new Set(kids.map(k => `${pNode.id}_${k.id}`));
      for (const [k, s] of this.taskSubs.entries()) {
        if (k.startsWith(pNode.id + '_') && !aliveKeys.has(k)) {
          s.unsubscribe();
          this.taskSubs.delete(k);
        }
      }

      // 親ノード置換
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

      // 件数ロード：親Problem自身＋子Issue
      try {
        await Promise.all([
          this.loadCountFor(pNode),
          ...kids.map(k => this.loadCountFor(k))
        ]);
      } catch {}

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
    ).subscribe(async tasks => {
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

          // 件数ロード：当該Issue＋子Task
          try {
            await Promise.all([
              this.loadCountFor(issueNode),
              ...kids.map(k => this.loadCountFor(k))
            ]);
          } catch {}

          this.recomputeProblemStatus(problemId);
        }
      }
    });

    this.taskSubs.set(key, sub);
  }

  // --- Dashboard state ---
  showDash = false;
  dash$!: Observable<{
    overdue: number; today: number; thisWeek: number; nextWeek: number; later: number; nodue: number;
    openTotal: number; doneTotal: number; progressPct: number;
  }>;

  // Chart.js options
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
  barData(d: { overdue: number; today: number; thisWeek: number; nextWeek: number; later: number; nodue: number; }) {
    return {
      labels: ['Overdue', 'Today', 'This week', 'Next week', 'Later', 'No due'],
      datasets: [{ data: [d.overdue, d.today, d.thisWeek, d.nextWeek, d.later, d.nodue], maxBarThickness: 22 }]
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
    overdue: number; today: number; thisWeek: number; nextWeek: number; later: number; nodue: number;
    openTotal: number; doneTotal: number; progressPct: number;
  }> {
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = this.addDays(today, 1);
  
    // 今週（月曜始まり）
    const dow = today.getDay();
    const diffToMon = (dow === 0 ? -6 : 1 - dow);
    const startOfWeek = this.addDays(today, diffToMon);
    const endOfWeek   = this.addDays(startOfWeek, 6);
  
    // 来週
    const startOfNextWeek = this.addDays(endOfWeek, 1);
    const endOfNextWeek   = this.addDays(startOfNextWeek, 6);
  
    const FAR = '9999-12-31';
  
    return this.currentProject.projectId$.pipe(
      switchMap(pid => {
        if (!pid) {
          return of({
            overdue: 0, today: 0, thisWeek: 0, nextWeek: 0, later: 0, nodue: 0,
            openTotal: 0, doneTotal: 0, progressPct: 0
          });
        }
  
        const overdue$   = this.tasks.listAllOverdue(pid, this.ymd(today), true);
        const today$     = this.tasks.listAllByDueRange(pid, this.ymd(today), this.ymd(today), true);
        const thisWeek$  = this.tasks.listAllByDueRange(pid, this.ymd(tomorrow), this.ymd(endOfWeek), true);
        const nextWeek$  = this.tasks.listAllByDueRange(pid, this.ymd(startOfNextWeek), this.ymd(endOfNextWeek), true);
        const later$     = this.tasks.listAllByDueRange(pid, this.ymd(this.addDays(endOfNextWeek,1)), FAR, true);
        const nodue$     = this.tasks.listAllNoDue(pid, true);
        const all$       = this.tasks.listAllByDueRange(pid, '0000-01-01', FAR, false);
  
        return combineLatest([overdue$, today$, thisWeek$, nextWeek$, later$, nodue$, all$]).pipe(
          map(([ov, td, wk, nw, lt, nd, all]) => {
            const overdue   = ov?.length ?? 0;
            const today     = td?.length ?? 0;
            const thisWeek  = wk?.length ?? 0;
            const nextWeek  = nw?.length ?? 0;
            const later     = lt?.length ?? 0;
            const nodue     = nd?.length ?? 0;
  
            const total     = all?.length ?? 0;
            const doneTotal = (all ?? []).filter(t => t.status === 'done').length;
            const openTotal = total - doneTotal;
            const progressPct = total > 0 ? Math.round((doneTotal / total) * 100) : 0;
  
            return { overdue, today, thisWeek, nextWeek, later, nodue, openTotal, doneTotal, progressPct };
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

  // コメントターゲットを算出
  private async toTarget(node: TreeNode): Promise<CommentTarget | null> {
    const projectId = await firstValueFrom(this.currentProject.projectId$);
    if (!projectId) return null;

    if (node.kind === 'problem') {
      return { kind:'problem', projectId, problemId: node.id };
    }
    if (node.kind === 'issue') {
      return { kind:'issue', projectId, problemId: node.parentId!, issueId: node.id };
    }
    return {
      kind:'task',
      projectId,
      problemId: node.parentProblemId!,
      issueId: node.parentIssueId!,
      taskId: node.id
    };
  }

  // ノード選択→コメント購読
  async openComments(node: TreeNode){
    this.selectedNode = node;
    const t = await this.toTarget(node);
    if (!t) {
      this.comments$ = undefined;
      return;
    }
    this.comments$ = this.comments.listByTarget(t, 50);
    this.newBody = '';
    this.editingId = null;
  }

  startEdit(id: string, current: string){
    this.editingId = id;
    this.newBody = current;
  }

  async addComment(){
    if (!this.selectedNode || !this.newBody.trim()) return;
    const t = await this.toTarget(this.selectedNode); if (!t) return;

    const uid = await firstValueFrom(this.auth.uid$);
    const name = await firstValueFrom(this.auth.displayName$);
    await this.comments.create(t, this.newBody.trim(), uid!, name || undefined);
    this.newBody = '';

    // バッジ即時反映
    this.bumpCount(this.selectedNode, +1);
  }

  async saveEdit(){
    const node = this.selectedNode; if (!node || !this.editingId || !this.newBody.trim()) return;
    const t = await this.toTarget(node); if (!t) return;
    await this.comments.update(t, this.editingId, this.newBody.trim());
    this.editingId = null;
    this.newBody = '';
  }

  cancelEdit(){
    this.editingId = null;
    this.newBody = '';
  }

  async deleteComment(id: string){
    const node = this.selectedNode; if (!node) return;
    const t = await this.toTarget(node); if (!t) return;
    await this.comments.delete(t, id);

    // バッジ即時反映
    this.bumpCount(node, -1);
  }

  // ===== コメント件数ロード／即時反映 =====
  private async loadCountFor(node: TreeNode) {
    const t = await this.toTarget(node);
    if (!t) return;
    try {
      const n = await this.comments.count(t);
      this.commentCounts[node.id] = n;
    } catch {}
  }

  private bumpCount(node: TreeNode | null, delta: number) {
    if (!node) return;
    const prev = this.commentCounts[node.id] ?? 0;
    this.commentCounts[node.id] = Math.max(0, prev + delta);
  }
}

