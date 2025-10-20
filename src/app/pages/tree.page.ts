import { Component } from '@angular/core';
import { NgIf } from '@angular/common';

import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';

import { MatButtonModule } from '@angular/material/button';
import { MatTreeNestedDataSource } from '@angular/material/tree';
import { NestedTreeControl } from '@angular/cdk/tree';
import { MatTreeModule } from '@angular/material/tree';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

type Status = 'not_started' | 'in_progress' | 'done';
type TreeNode = {
  id: string;
  name: string;
  kind: 'problem' | 'issue' | 'task';
  status?: Status;
  parentId?: string;
  parentIssueId?: string;
  parentProblemId?: string;
  children?: TreeNode[];
};

@Component({
  standalone: true,
  selector: 'pp-tree',
  imports: [NgIf, MatButtonModule, MatTreeModule, MatIconModule, MatTooltipModule],
  template: `
    <h3>Problems</h3>

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
          <button mat-button type="button" (click)="renameProblemNode(node)">Rename</button>
          <button mat-button type="button" color="warn" (click)="removeProblemNode(node)">Delete</button>
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
          <button mat-button type="button" (click)="renameTaskNode(node)">Rename</button>
          <button mat-button type="button" color="warn" (click)="removeTaskNode(node)">Delete</button>
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

  // MatTreeのノード操作（軽い編集だけ残す）
  renameProblemNode(node: { id: string; name: string }) {
    const t = prompt('New Problem title', node.name);
    if (t && t.trim()) this.problems.update(node.id, { title: t.trim() });
  }
  removeProblemNode(node: { id: string; name: string }) {
    if (confirm(`Delete "${node.name}"?`)) this.problems.remove(node.id);
  }

  renameIssueNode(node: { id: string; name: string; parentId?: string }) {
    if (!node.parentId) return;
    const t = prompt('New Issue title', node.name);
    if (t && t.trim()) this.issues.update(node.parentId, node.id, { title: t.trim() });
  }
  removeIssueNode(node: { id: string; name: string; parentId?: string }) {
    if (!node.parentId) return;
    if (confirm(`Delete Issue "${node.name}"?`)) this.issues.remove(node.parentId, node.id);
  }

  renameTaskNode(node: { id: string; name: string; parentProblemId?: string; parentIssueId?: string }) {
    if (!node.parentProblemId || !node.parentIssueId) return;
    const t = prompt('New Task title', node.name);
    if (t && t.trim()) this.tasks.update(node.parentProblemId, node.parentIssueId, node.id, { title: t.trim() });
  }
  async removeTaskNode(node: { id: string; name: string; parentProblemId?: string; parentIssueId?: string }) {
    if (!node.parentProblemId || !node.parentIssueId || this.isBusyId(node.id)) return;
    if (confirm(`Delete Task "${node.name}"?`)) {
      this.busyIds.add(node.id!);
      try {
        await this.tasks.remove(node.parentProblemId, node.parentIssueId, node.id!);
      } finally {
        this.busyIds.delete(node.id!);
      }
    }
  }

  data: TreeNode[] = [];
  tree = new NestedTreeControl<TreeNode>(n => n.children ?? []);
  private subForTree?: import('rxjs').Subscription;

  private issueSubs = new Map<string, import('rxjs').Subscription>(); // problemId -> sub
  private taskSubs  = new Map<string, import('rxjs').Subscription>(); // `${problemId}_${issueId}` -> sub

  constructor(
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService
  ) {}

  ngOnInit() { this.startProblemsSubscription(); }

  private startProblemsSubscription() {
    this.isLoadingProblems = true;
    this.loadError = null;

    this.subForTree?.unsubscribe();
    this.subForTree = this.problems.list().subscribe({
      next: rows => {
        this.data = rows.map(r => ({
          id: r.id!,
          name: r.title,
          kind: 'problem',
          status: 'not_started',
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

    const sub = this.issues.listByProblem(pNode.id).subscribe(issues => {
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

    const sub = this.tasks.listByIssue(problemId, issueNode.id).subscribe(tasks => {
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
}
