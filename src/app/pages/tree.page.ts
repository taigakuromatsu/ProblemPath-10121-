import { Component } from '@angular/core';
import { AsyncPipe, NgFor, NgIf, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';

import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { Problem, Issue, Task } from '../models/types';
import { MatButtonModule } from '@angular/material/button';
import { MatTreeNestedDataSource } from '@angular/material/tree';


import { NestedTreeControl } from '@angular/cdk/tree';
import { MatTreeModule } from '@angular/material/tree';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MaintenanceService } from '../services/maintenance.service';


import { RouterLink } from '@angular/router';

type Status = 'not_started' | 'in_progress' | 'done';
type TreeNode = { id: string; name: string; kind: 'problem' | 'issue' | 'task'; 
    status?: Status;
    parentId?: string;
    parentIssueId?: string;
    parentProblemId?: string;
    children?: TreeNode[];
};


@Component({
  standalone: true,
  selector: 'pp-tree',
  imports: [AsyncPipe, NgFor, NgIf, FormsModule, MatButtonModule, MatTreeModule, MatIconModule, RouterLink, MatTooltipModule, DatePipe],
  template: `
    <h3>Problems</h3>

    <!-- ★ 追加：エラー表示＆再試行 -->
<div *ngIf="loadError" style="padding:8px 12px; border:1px solid #f44336; background:#ffebee; color:#b71c1c; border-radius:6px; margin:8px 0;">
  {{ loadError }}
  <button mat-button color="warn" type="button" (click)="retryProblems()" style="margin-left:8px;">
    再試行
  </button>
</div>

    <!-- Problem追加 -->
    <form (ngSubmit)="createProblem()" style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
      <input [(ngModel)]="problemTitle" name="problemTitle" placeholder="New Problem title" required />
      <button mat-raised-button color="primary" type="submit">＋ Add Problem</button>
    </form>

    <!-- Problem一覧 -->
    <ul *ngIf="problems$ | async as problems; else loading" style="line-height:1.8">
      <li *ngFor="let p of problems">
        <strong>{{ p.title }}</strong>
        <button mat-button type="button" (click)="moveProblemUp(p)"  aria-label="Move up">▲</button>
        <button mat-button type="button" (click)="moveProblemDown(p)" aria-label="Move down">▼</button>
        <button mat-button type="button" (click)="renameProblem(p)">Rename</button>
        <button mat-button type="button" color="warn" (click)="removeProblem(p)">Delete</button>
        <a mat-button [routerLink]="['/board']" [queryParams]="{ pid: p.id }">Boardで見る</a>


        <!-- Issue操作 -->
        <div style="margin:6px 0 10px 16px;">
          <button mat-button type="button" (click)="toggleIssues(p.id!)">
            {{ issuesShown[p.id!] ? '▲ Hide Issues' : '▼ Show Issues' }}
          </button>

          <!-- Issue追加 -->
          <form *ngIf="issuesShown[p.id!]" (ngSubmit)="createIssue(p.id!)" style="display:flex; gap:6px; margin-top:8px;">
            <input [(ngModel)]="issueTitle[p.id!]" name="issueTitle-{{p.id}}" placeholder="New Issue title" required />
            <button mat-raised-button color="primary" type="submit">＋ Add Issue</button>
          </form>

          <!-- Issue一覧 -->
          <ul *ngIf="issuesShown[p.id!] && (issuesMap[p.id!] | async) as issues" style="margin-left:12px;">
            <li *ngFor="let i of issues">
              - <strong>{{ i.title }}</strong>
              <button mat-button type="button" (click)="moveIssueUp(p.id!, i)">▲</button>
              <button mat-button type="button" (click)="moveIssueDown(p.id!, i)">▼</button>
              <button mat-button type="button" (click)="renameIssue(p.id!, i)">Rename</button>
              <button mat-button type="button" color="warn" (click)="removeIssue(p.id!, i)">Delete</button>

              <!-- Task操作 -->
              <div style="margin:6px 0 8px 16px;">
                <button mat-button type="button" (click)="toggleTasks(p.id!, i.id!)">
                  {{ tasksShown[key(p.id!, i.id!)] ? '▲ Hide Tasks' : '▼ Show Tasks' }}
                </button>

                <!-- Task追加 -->
                <form *ngIf="tasksShown[key(p.id!, i.id!)]"
                      (ngSubmit)="createTask(p.id!, i.id!)"
                      style="display:flex; gap:6px; margin-top:8px;">
                  <input [(ngModel)]="taskTitle[key(p.id!, i.id!)]"
                         name="taskTitle-{{ key(p.id!, i.id!) }}"
                         placeholder="New Task title" required />
                  <button mat-raised-button color="primary" type="submit">＋ Add Task</button>
                </form>

                <!-- Task一覧 -->
                <ul *ngIf="tasksShown[key(p.id!, i.id!)] && (tasksMap[key(p.id!, i.id!)] | async) as tasks"
                    style="margin-left:12px;">
                  <li *ngFor="let t of tasks">
                    · {{ t.title }}
                    <button mat-button type="button" (click)="moveTaskUp(p.id!, i.id!, t)">▲</button>
                    <button mat-button type="button" (click)="moveTaskDown(p.id!, i.id!, t)">▼</button>
                    <button mat-button type="button" (click)="renameTask(p.id!, i.id!, t)">Rename</button>
                    <button mat-button type="button" color="warn" (click)="removeTask(p.id!, i.id!, t)">Delete</button>
                    <!-- 追加: 期限入力 -->
                    <span style="margin-left:8px;">
                      <input type="date"
                            [ngModel]="dateField(t.dueDate)"
                            (ngModelChange)="setDue(p.id!, i.id!, t, $event)"
                            style="padding:2px 6px; border:1px solid #ddd; border-radius:6px;"
                            [title]="t.dueDate ? ('due: ' + (t.dueDate | date:'yyyy-MM-dd')) : '期限未設定'"/>
                      <span *ngIf="isOverdue(t)" style="color:#dc2626; font-size:12px; margin-left:6px;">期限切れ</span>
                    </span>
                  </li>
                  <li *ngIf="tasks.length === 0" style="opacity:.7">（Taskはまだありません）</li>
                </ul>
              </div>
            </li>
            <li *ngIf="issues.length === 0" style="opacity:.7">（Issueはまだありません）</li>
          </ul>
        </div>
      </li>
      <li *ngIf="problems.length === 0" style="opacity:.7">（Problemはまだありません）</li>
    </ul>

    <hr style="margin:16px 0; opacity:.3;">
    <h4>Problems (MatTree preview)</h4>

    <mat-tree [dataSource]="dataSource" [treeControl]="tree" class="mat-elevation-z1">

  <!-- Problem（親） -->
  <mat-nested-tree-node *matTreeNodeDef="let node; when: isProblem">
    <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid rgba(0,0,0,.06);">
      <button mat-icon-button matTreeNodeToggle [disabled]="!(node.children?.length)">
        <mat-icon>{{ tree.isExpanded(node) ? 'expand_more' : 'chevron_right' }}</mat-icon>
      </button>
      <span style="font-weight:600">{{ node.name }}</span>
      <span style="flex:1 1 auto"></span>
      <button mat-button type="button" (click)="renameProblemNode(node)">Rename</button>
      <button mat-button type="button" color="warn" (click)="removeProblemNode(node)">Delete</button>
    </div>
    <div *ngIf="tree.isExpanded(node)"><ng-container matTreeNodeOutlet></ng-container></div>
  </mat-nested-tree-node>

  <!-- Issue（親） -->
  <mat-nested-tree-node *matTreeNodeDef="let node; when: isIssue">
    <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid rgba(0,0,0,.06); margin-left:24px;">
      <button mat-icon-button matTreeNodeToggle [disabled]="!(node.children?.length)">
        <mat-icon>{{ tree.isExpanded(node) ? 'expand_more' : 'chevron_right' }}</mat-icon>
      </button>
      <span>{{ node.name }}</span>
      <span style="flex:1 1 auto"></span>
      <button mat-button type="button" (click)="renameIssueNode(node)">Rename</button>
    <button mat-button type="button" color="warn" (click)="removeIssueNode(node)">Delete</button>
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
          <span [style.color]="statusColor(node.status)" matTooltip="{{ node.status==='done' ? '完了' : node.status==='in_progress' ? '対応中' : '未着手' }}">
            {{ statusIcon(node.status) }}
          </span>
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto;" [matTooltip]="node.name">
            {{ node.name }}
          </span>
        </span>

      <span style="flex:1 1 auto"></span>
      <button mat-button type="button" (click)="renameTaskNode(node)">Rename</button>
      <button mat-button type="button" color="warn" (click)="removeTaskNode(node)">Delete</button>
    </div>
  </mat-nested-tree-node>

</mat-tree>




    <ng-template #loading>Loading...</ng-template>
  `
})



export class TreePage {

    
  // 追加：表示用ユーティリティ
  statusIcon(s?: Status) {
    if (s === 'done') return '✅';
    if (s === 'in_progress') return '🔼';
    return '✕'; // not_started or undefined
  }
  statusColor(s?: Status) {
    if (s === 'done') return '#16a34a';       // 緑
    if (s === 'in_progress') return '#2563eb';// 青
    return '#dc2626';                         // 赤
  }

  busyIds = new Set<string>();
  isBusyId(id?: string|null){ return !!id && this.busyIds.has(id); }

  // 追加：配列から Issue / Problem の集計ステータスを決める
  private decideAggregateStatus(taskStatuses: Status[]): Status {
    if (!taskStatuses.length) return 'not_started';
    if (taskStatuses.some(s => s === 'in_progress')) return 'in_progress';
    if (taskStatuses.every(s => s === 'done')) return 'done';
    // それ以外（= 未着手混在）は not_started を優先
    return 'not_started';
  }  

  // ★追加：Problem の集計更新
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

    // MatTreeのノードからProblemを操作するアダプタ
  renameProblemNode(node: { id: string; name: string }) {
    const t = prompt('New Problem title', node.name);
    if (t && t.trim()) {
      this.problems.update(node.id, { title: t.trim() });
    }
  }
  
  removeProblemNode(node: { id: string; name: string }) {
    if (confirm(`Delete "${node.name}"?`)) {
      this.problems.remove(node.id);
    }
  }

  // MatTreeのノードから Issue を操作するアダプタ
  renameIssueNode(node: { id: string; name: string; parentId?: string }) {
    if (!node.parentId) return;  // 念のためガード
    const t = prompt('New Issue title', node.name);
    if (t && t.trim()) {
      this.issues.update(node.parentId, node.id, { title: t.trim() });
    }
  }
  
  removeIssueNode(node: { id: string; name: string; parentId?: string }) {
    if (!node.parentId) return;
    if (confirm(`Delete Issue "${node.name}"?`)) {
      this.issues.remove(node.parentId, node.id);
    }
  }
  
  renameTaskNode(node: { id: string; name: string; parentProblemId?: string; parentIssueId?: string }) {
    if (!node.parentProblemId || !node.parentIssueId) return;
    const t = prompt('New Task title', node.name);
    if (t && t.trim()) {
      this.tasks.update(node.parentProblemId, node.parentIssueId, node.id, { title: t.trim() });
    }
  }

  async removeTaskNode(node: { id: string; name: string; parentProblemId?: string; parentIssueId?: string }) {
    if (!node.parentProblemId || !node.parentIssueId || this.isBusyId(node.id)) return;
    if (confirm(`Delete Task "${node.name}"?`)) {
      this.busyIds.add(node.id!);
      try {
        await this.tasks.remove(node.parentProblemId, node.parentIssueId, node.id!);
      } catch {
        // 任意で alert('削除に失敗しました');
      } finally {
        this.busyIds.delete(node.id!);
      }
    }
  }


  
  problems$!: Observable<Problem[]>;
  problemTitle = '';

  // Issue購読/UI状態
  issuesMap: Record<string, Observable<Issue[]>> = {};
  issuesShown: Record<string, boolean> = {};
  issueTitle: Record<string, string> = {};

  // Task購読/UI状態（problemId_issueId をキーにする）
  tasksMap: Record<string, Observable<Task[]>> = {};
  tasksShown: Record<string, boolean> = {};
  taskTitle: Record<string, string> = {};

  dataSource = new MatTreeNestedDataSource<TreeNode>();
  isProblem = (_: number, node: TreeNode) => node.kind === 'problem';
  isIssue = (_: number, node: TreeNode) => node.kind === 'issue';



  constructor(
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    private maintenance: MaintenanceService
  ) {}

  ngOnInit() {
    this.startProblemsSubscription();
   }

   // ★ 追加：購読開始（再試行でも使う）
private startProblemsSubscription() {
    this.isLoadingProblems = true;
    this.loadError = null;
  
    this.problems$ = this.problems.list();
  
    this.subForTree?.unsubscribe();
    this.subForTree = this.problems.list().subscribe({
      next: rows => {
        this.data = rows.map(r => ({
            id: r.id!,
            name: r.title,
            kind: 'problem',
            status: 'not_started',     // ← ここを新規付加
            children: [] as TreeNode[]
          }));
  
        // 参照ごと差し替えで通知
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
  
  // ★ 追加：再試行
  retryProblems() {
    this.startProblemsSubscription();
  }
  

   ngOnDestroy() {
    this.subForTree?.unsubscribe();
    this.issueSubs.forEach(s => s.unsubscribe());
    this.taskSubs.forEach(s => s.unsubscribe());
  }
  

  // ---- Problem CRUD ----
  async createProblem() {
    const t = this.problemTitle.trim();
    if (!t) return;
    await this.problems.create({ title: t });
    this.problemTitle = '';
  }
  async renameProblem(p: Problem) {
    const t = prompt('New Problem title', p.title);
    if (t && t.trim()) await this.problems.update(p.id!, { title: t.trim() });
  }
  async removeProblem(p: Problem) {
    if (confirm(`Delete "${p.title}"?`)) await this.problems.remove(p.id!);
  }

  async moveProblemUp(p: Problem) {
    if (p.id == null || p.order == null) return;
    await this.problems.moveUp(p.id, p.order);
  }
  
  async moveProblemDown(p: Problem) {
    if (p.id == null || p.order == null) return;
    await this.problems.moveDown(p.id, p.order);
  }
  




  // ---- Issue 表示＆CRUD ----
  toggleIssues(problemId: string) {
    if (!this.issuesShown[problemId]) {
      this.issuesMap[problemId] = this.issues.listByProblem(problemId);
      this.issuesShown[problemId] = true;
    } else {
      this.issuesShown[problemId] = !this.issuesShown[problemId];
    }
  }
  async createIssue(problemId: string) {
    const t = (this.issueTitle[problemId] ?? '').trim();
    if (!t) return;
    await this.issues.create(problemId, { title: t });
    this.issueTitle[problemId] = '';
  }
  async renameIssue(problemId: string, i: Issue) {
    const t = prompt('New Issue title', i.title);
    if (t && t.trim()) await this.issues.update(problemId, i.id!, { title: t.trim() });
  }
  async removeIssue(problemId: string, i: Issue) {
    if (confirm(`Delete Issue "${i.title}"?`)) await this.issues.remove(problemId, i.id!);
  }
  async moveIssueUp(problemId: string, i: Issue) {
    if (!i.id || i.order == null) return;
    await this.issues.moveUp(problemId, i.id, i.order);
  }
  
  async moveIssueDown(problemId: string, i: Issue) {
    if (!i.id || i.order == null) return;
    await this.issues.moveDown(problemId, i.id, i.order);
  }  



  // ---- Task 表示＆CRUD ----
  key(problemId: string, issueId: string) { return `${problemId}_${issueId}`; }

  toggleTasks(problemId: string, issueId: string) {
    const k = this.key(problemId, issueId);
    if (!this.tasksShown[k]) {
      this.tasksMap[k] = this.tasks.listByIssue(problemId, issueId);
      this.tasksShown[k] = true;
    } else {
      this.tasksShown[k] = !this.tasksShown[k];
    }
  }
  async createTask(problemId: string, issueId: string) {
    const k = this.key(problemId, issueId);
    const t = (this.taskTitle[k] ?? '').trim();
    if (!t) return;
    await this.tasks.create(problemId, issueId, { title: t });
    this.taskTitle[k] = '';
  }
  async renameTask(problemId: string, issueId: string, task: Task) {
    const t = prompt('New Task title', task.title);
    if (t && t.trim()) await this.tasks.update(problemId, issueId, task.id!, { title: t.trim() });
  }
  async removeTask(problemId: string, issueId: string, task: Task) {
    if (confirm(`Delete Task "${task.title}"?`)) {
      await this.tasks.remove(problemId, issueId, task.id!);
    }
  }
  async moveTaskUp(problemId: string, issueId: string, t: Task) {
    if (!t.id || t.order == null) return;
    await this.tasks.moveUp(problemId, issueId, t.id, t.order);
  }
  
  async moveTaskDown(problemId: string, issueId: string, t: Task) {
    if (!t.id || t.order == null) return;
    await this.tasks.moveDown(problemId, issueId, t.id, t.order);
  }



  data: TreeNode[] = [];
  tree = new NestedTreeControl<TreeNode>(n => n.children ?? []);
  private subForTree?: import('rxjs').Subscription;

  

  private issueSubs = new Map<string, import('rxjs').Subscription>(); // problemId -> sub

  private attachIssueSubscription(pNode: TreeNode) {
    // 既存購読があれば解除
    this.issueSubs.get(pNode.id)?.unsubscribe();
  
    const sub = this.issues.listByProblem(pNode.id).subscribe(issues => {
      // 1) 最新の Issue ノード群を生成
      const kids: TreeNode[] = issues.map(i => ({
        id: i.id!,
        name: i.title,
        kind: 'issue',
        parentId: pNode.id,
        status: 'not_started' // ← 追加
      }));

      // kids 生成の直後に追加
      const aliveKeys = new Set(kids.map(k => `${pNode.id}_${k.id}`));
      for (const [k, sub] of this.taskSubs.entries()) {
        // この Problem に属する Task 購読で、今は存在しない Issue のものを掃除
        if (k.startsWith(pNode.id + '_') && !aliveKeys.has(k)) {
          sub.unsubscribe();
          this.taskSubs.delete(k);
        }
      }
  
      // 2) 親ノードを“新オブジェクト”で置き換え（参照更新）
      const pIdx = this.data.findIndex(n => n.id === pNode.id);
      if (pIdx !== -1) {
        const newNode: TreeNode = { ...this.data[pIdx], children: kids };
        this.data = [
          ...this.data.slice(0, pIdx),
          newNode,
          ...this.data.slice(pIdx + 1)
        ];
      }
  
      // 3) まずツリーに通知（参照ごと差し替え）
      this.tree.dataNodes = [...this.data];
      this.dataSource.data = [...this.data];
  
      this.recomputeProblemStatus(pNode.id);

      // 4) ★ここで“最新のIssue配列”に対して Task 購読を張る
      for (const issueNode of kids) {
        this.attachTaskSubscription(pNode.id, issueNode);
      }
    });
  
    this.issueSubs.set(pNode.id, sub);
  }




private taskSubs = new Map<string, import('rxjs').Subscription>(); // key = `${problemId}_${issueId}`

// IssueノードにTaskの購読を張る
private attachTaskSubscription(problemId: string, issueNode: TreeNode) {
  const key = `${problemId}_${issueNode.id}`;
  this.taskSubs.get(key)?.unsubscribe();

  const sub = this.tasks.listByIssue(problemId, issueNode.id).subscribe(tasks => {
    const kids: TreeNode[] = tasks.map(t => ({
        id: t.id!,
        name: t.title,
        kind: 'task',
        status: (t.status as Status) ?? 'not_started', // ← 追加
        parentIssueId: issueNode.id,
        parentProblemId: problemId
      }));

    // issueNode を置き換え（参照を更新）
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

// 入力[type=date]用に "YYYY-MM-DD" を返す（'YYYY-MM-DD' or ''）
dateField(dateStr?: string | null): string {
  return (dateStr ?? '') || '';
}

// 期限の保存（val は 'YYYY-MM-DD' or ''）→ そのまま保存（toISOString禁止）
async setDue(problemId: string, issueId: string, t: Task, val: string) {
  const dueDate = val ? val : null; // ← ここをISO化しない！
  await this.tasks.update(problemId, issueId, t.id!, { dueDate });
}

// 期限切れ表示（文字列比較で安全に判定）
isOverdue(t: Task): boolean {
  if (!t?.dueDate) return false;
  if (t.status === 'done') return false;
  const todayStr = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  return t.dueDate < todayStr;
}


}
