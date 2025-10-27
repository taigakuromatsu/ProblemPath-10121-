// src/app/pages/tree.page.ts
import { Component } from '@angular/core';
import { NgIf, NgFor, AsyncPipe, DatePipe, DecimalPipe } from '@angular/common';
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
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { serverTimestamp } from 'firebase/firestore';
import { NgChartsModule } from 'ng2-charts';
import { ChartConfiguration } from 'chart.js';
import { Observable, combineLatest, of, firstValueFrom } from 'rxjs';
import { map, switchMap, take, tap } from 'rxjs/operators';
import { MembersService } from '../services/members.service';
import { CommentsService, CommentDoc, CommentTarget } from '../services/comments.service';
import { DraftsService } from '../services/drafts.service';
import { NetworkService } from '../services/network.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core'; 
import { AttachmentsService, AttachmentDoc, AttachmentTarget } from '../services/attachments.service';

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
    NgIf, NgFor, AsyncPipe, DatePipe, DecimalPipe, FormsModule,
    MatButtonModule, MatTreeModule, MatIconModule, MatTooltipModule,
    NgChartsModule, MatSnackBarModule, TranslateModule
  ],
  template: `
    <h3>{{ 'tree.title' | translate }}</h3>

    <div style="display:flex; align-items:center; gap:12px; margin:8px 0;">
      <span style="flex:1 1 auto;"></span>
      <ng-container *ngIf="auth.loggedIn$ | async; else signinT">
        <span style="opacity:.8; margin-right:6px;">{{ (auth.displayName$ | async) || ('auth.signedIn' | translate) }}</span>
        <button mat-stroked-button type="button" (click)="auth.signOut()">{{ 'auth.signOut' | translate }}</button>
      </ng-container>
      <ng-template #signinT>
        <button mat-raised-button color="primary" type="button" (click)="auth.signInWithGoogle()">{{ 'auth.signIn' | translate }}</button>
      </ng-template>
    </div>

    <!-- ===== Dashboard ===== -->
    <div style="display:flex; align-items:center; gap:8px; margin:8px 0 12px;">
      <button mat-stroked-button type="button" (click)="showDash = !showDash">
        {{ showDash ? ('tree.hideDashboard' | translate) : ('tree.showDashboard' | translate) }}
      </button>
    </div>

    <div *ngIf="showDash && (dash$ | async) as d"
         style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:12px; margin-bottom:12px;">
      <!-- 左：円グラフ -->
      <div style="border:1px solid #e5e7eb; border-radius:10px; padding:8px;">
        <div style="font-weight:600; margin-bottom:6px; font-size:13px;">{{ 'tree.overallStatus' | translate }}</div>
        <div style="height:180px;">
          <canvas baseChart
            [type]="'doughnut'"
            [data]="doughnutData(d.openTotal, d.doneTotal)"
            [options]="doughnutOptions">
          </canvas>
        </div>
        <div style="display:flex; gap:10px; margin-top:6px; font-size:12px; opacity:.8;">
          <span>{{ 'tree.open' | translate }}: {{ d.openTotal }}</span>
          <span>{{ 'tree.done' | translate }}: {{ d.doneTotal }}</span>
          <span>{{ 'tree.total' | translate }}: {{ d.openTotal + d.doneTotal }}</span>
          <span>{{ 'tree.progress' | translate }}: {{ d.progressPct }}%</span>
        </div>
      </div>

      <!-- 右：棒グラフ -->
      <div style="border:1px solid #e5e7eb; border-radius:10px; padding:8px;">
        <div style="font-weight:600; margin-bottom:6px; font-size:13px;">{{ 'tree.openTasksByDue' | translate }}</div>
        <div style="height:200px;">
          <canvas baseChart
            [type]="'bar'"
            [data]="barData(d)"
            [options]="barOptions">
          </canvas>
        </div>
        <div style="display:flex; gap:10px; margin-top:6px; font-size:12px; opacity:.8;">
          <span>{{ 'tree.overdue' | translate }}: {{ d.overdue }}</span>
          <span>{{ 'tree.today' | translate }}: {{ d.today }}</span>
          <span>{{ 'tree.thisWeek' | translate }}: {{ d.thisWeek }}</span>
          <span>{{ 'tree.nextWeek' | translate }}: {{ d.nextWeek }}</span>
          <span>{{ 'tree.later' | translate }}: {{ d.later }}</span>
          <span>{{ 'tree.noDue' | translate }}: {{ d.nodue }}</span>
        </div>
      </div>
    </div>
    <!-- ===== /Dashboard ===== -->

    <div style="display:grid; grid-template-columns: 1fr 360px; gap:12px; align-items:start;">

      <!-- 左：ツリー -->
      <div>
        <div *ngIf="loadError" style="padding:8px 12px; border:1px solid #f44336; background:#ffebee; color:#b71c1c; border-radius:6px; margin:8px 0;">
          {{ loadError }}
          <button mat-button color="warn" type="button" (click)="retryProblems()" style="margin-left:8px;">
            {{ 'common.retry' | translate }}
          </button>
        </div>

        <mat-tree [dataSource]="dataSource" [treeControl]="tree" class="mat-elevation-z1">

          <!-- Problem -->
          <mat-nested-tree-node *matTreeNodeDef="let node; when: isProblem">
            <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid rgba(0,0,0,.06);">
              <button mat-icon-button matTreeNodeToggle [disabled]="!(node.children?.length)">
                <mat-icon>{{ tree.isExpanded(node) ? 'expand_more' : 'chevron_right' }}</mat-icon>
              </button>
              <span style="font-weight:600">{{ node.name }}</span>
              <span style="flex:1 1 auto"></span>

              <button mat-button type="button" (click)="openComments(node)">
                  💬 {{ 'cf.count' | translate:{
                        c: (commentCounts[node.id] ?? 0),
                        f: (attachmentCounts[node.id] ?? 0)
                      } }}
              </button>

              <button mat-button type="button" (click)="renameProblemNode(node)" *ngIf="isEditor$ | async" [disabled]="!(canEdit$ | async)">{{ 'common.rename' | translate }}</button>
              <button mat-button type="button" color="warn" (click)="removeProblemNode(node)" *ngIf="isEditor$ | async" [disabled]="!(canEdit$ | async)">{{ 'common.delete' | translate }}</button>
            </div>
            <div *ngIf="tree.isExpanded(node)"><ng-container matTreeNodeOutlet></ng-container></div>
          </mat-nested-tree-node>

          <!-- Issue -->
          <mat-nested-tree-node *matTreeNodeDef="let node; when: isIssue">
            <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid rgba(0,0,0,.06); margin-left:24px;">
              <button mat-icon-button matTreeNodeToggle [disabled]="!(node.children?.length)">
                <mat-icon>{{ tree.isExpanded(node) ? 'expand_more' : 'chevron_right' }}</mat-icon>
              </button>
              <span>{{ node.name }}</span>
              <span style="flex:1 1 auto"></span>

              <button mat-button type="button" (click)="openComments(node)">
                  💬 {{ 'cf.count' | translate:{
                        c: (commentCounts[node.id] ?? 0),
                        f: (attachmentCounts[node.id] ?? 0)
                      } }}
              </button>

              <button mat-button type="button" (click)="renameIssueNode(node)" *ngIf="isEditor$ | async" [disabled]="!(canEdit$ | async)">{{ 'common.rename' | translate }}</button>
              <button mat-button type="button" color="warn" (click)="removeIssueNode(node)" *ngIf="isEditor$ | async" [disabled]="!(canEdit$ | async)">{{ 'common.delete' | translate }}</button>
            </div>
            <div *ngIf="tree.isExpanded(node)"><ng-container matTreeNodeOutlet></ng-container></div>
          </mat-nested-tree-node>

          <!-- Task -->
          <mat-nested-tree-node *matTreeNodeDef="let node">
            <div style="display:flex; align-items:center; gap:8px; padding:6px 8px;
                        border-bottom:1px solid rgba(0,0,0,.06); margin-left:56px;
                        border-left:4px solid {{ statusColor(node.status) }};">
              <button mat-icon-button disabled><mat-icon>task_alt</mat-icon></button>
              <span style="display:flex; align-items:center; gap:6px; max-width: 520px;">
                <span [style.color]="statusColor(node.status)"
                      matTooltip="{{ node.status==='done' ? ('status.done' | translate) : node.status==='in_progress' ? ('status.inProgress' | translate) : ('status.notStarted' | translate) }}">
                  {{ statusIcon(node.status) }}
                </span>
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto;"
                      [matTooltip]="node.name">
                  {{ node.name }}
                </span>
              </span>

              <span style="flex:1 1 auto"></span>

              <button mat-button type="button" (click)="openComments(node)">
                  💬 {{ 'cf.count' | translate:{
                        c: (commentCounts[node.id] ?? 0),
                        f: (attachmentCounts[node.id] ?? 0)
                      } }}
              </button>

              <button mat-button type="button" (click)="renameTaskNode(node)" *ngIf="isEditor$ | async" [disabled]="!(canEdit$ | async)">{{ 'common.rename' | translate }}</button>
              <button mat-button type="button" color="warn" (click)="removeTaskNode(node)" *ngIf="isEditor$ | async" [disabled]="!(canEdit$ | async)">{{ 'common.delete' | translate }}</button>
            </div>
          </mat-nested-tree-node>

        </mat-tree>
      </div>

      <!-- 右：コメントパネル -->
      <aside style="border:1px solid #e5e7eb; border-radius:10px; padding:10px; position:sticky; top:12px; height:fit-content;">
        <div *ngIf="!selectedNode" style="opacity:.65;">{{ 'comment.emptyHint' | translate }}</div>

        <ng-container *ngIf="selectedNode">
          <div style="font-weight:700; margin-bottom:8px;">
            💬 {{ 'cf.header' | translate:{ kind: selectedNode.kind, name: selectedNode.name } }}
          </div>

          <div *ngIf="!(isOnline$ | async)" style="margin-bottom:6px; font-size:12px; color:#b45309; background:#fffbeb; border:1px solid #fcd34d; padding:6px 8px; border-radius:6px;">
            {{ 'warn.offlineComments' | translate }}
          </div>

          <div style="display:flex; gap:6px; margin-bottom:8px;">
            <textarea [(ngModel)]="newBody"
                      (ngModelChange)="onCommentBodyChange($event)"
                      [disabled]="!(canEdit$ | async)"
                      rows="3" style="flex:1; width:100%;"
                      [placeholder]="'comment.placeholder' | translate"></textarea>
          </div>
          <div style="display:flex; gap:8px; margin-bottom:12px;">
            <button mat-raised-button color="primary" (click)="editingId ? saveEdit() : addComment()"
                    [disabled]="!newBody.trim() || !(canEdit$ | async)">
              {{ editingId ? ('comment.update' | translate) : ('comment.post' | translate) }}
            </button>
            <button mat-stroked-button (click)="cancelEdit()" *ngIf="editingId">{{ 'common.cancel' | translate }}</button>
          </div>

          <div *ngIf="comments$ | async as cs; else loadingC">
            <div *ngIf="!cs.length" style="opacity:.65;">{{ 'comment.noneYet' | translate }}</div>
            <div *ngFor="let c of cs" style="border-top:1px solid #eee; padding:8px 0;">
              <div style="font-size:12px; opacity:.75;">
                <span>{{ c.authorName || c.authorId }}</span> ・
                <span>{{ c.createdAt?.toDate?.() ? (c.createdAt.toDate() | date:'yyyy/MM/dd HH:mm') : '' }}</span>
              </div>
              <div style="white-space:pre-wrap;">{{ c.body }}</div>

              <div style="display:flex; gap:6px; margin-top:6px;"
                   *ngIf="(members.isAdmin$ | async) || ((auth.uid$ | async) === c.authorId)">
                <button mat-button (click)="startEdit(c.id!, c.body)" [disabled]="!(canEdit$ | async)">{{ 'common.edit' | translate }}</button>
                <button mat-button color="warn" (click)="deleteComment(c.id!)" [disabled]="!(canEdit$ | async)">{{ 'common.delete' | translate }}</button>
              </div>
            </div>
          </div>
          <ng-template #loadingC><div style="opacity:.65;">{{ 'common.loading' | translate }}</div></ng-template>
        </ng-container>

        <!-- ========== 添付ブロック ========== -->
        <div *ngIf="selectedNode"
             style="border-top:1px solid #eee; margin:10px 0 0; padding-top:10px;">
          <div style="font-weight:700; margin-bottom:8px;">
            📎 添付ファイル
          </div>

          <div style="display:flex; gap:8px; margin-bottom:10px; align-items:center;">
            <input type="file"
                  multiple
                  accept="image/*,.pdf"
                  (change)="onPickFiles($event)"
                  [disabled]="uploadBusy || !(canEdit$ | async)">
            <span *ngIf="uploadBusy" style="font-size:12px; opacity:.75;">アップロード中…</span>
          </div>

          <div *ngIf="attachments$ | async as ats; else loadingAts">
            <div *ngIf="!ats.length" style="opacity:.65;">（まだありません）</div>
            <div *ngFor="let a of ats" style="display:flex; gap:8px; align-items:center; border-top:1px solid #eee; padding:8px 0;">
              <!-- サムネ（画像のみ） -->
              <img *ngIf="a.downloadURL && a.contentType?.startsWith('image/')"
                  [src]="a.downloadURL"
                  alt=""
                  style="width:48px; height:48px; object-fit:cover; border:1px solid #e5e7eb; border-radius:6px;">
              <span *ngIf="!a.contentType?.startsWith('image/')" style="font-size:20px;">📄</span>

              <div style="flex:1 1 auto; min-width:0;">
                <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                  {{ a.name }}
                </div>
                <div style="font-size:12px; opacity:.7;">
                  {{ a.contentType || 'binary' }} ・ {{ a.size | number }} bytes
                </div>
              </div>

              <a *ngIf="a.downloadURL" mat-stroked-button [href]="a.downloadURL" target="_blank" rel="noopener">開く</a>
              <button mat-button color="warn"
                      (click)="removeAttachment(a)"
                      [disabled]="!(canEdit$ | async)">
                削除
              </button>
            </div>
          </div>
          <ng-template #loadingAts><div style="opacity:.65;">読み込み中…</div></ng-template>
        </div>
        <!-- ========== /添付ブロック ========== -->

      </aside>
    </div>
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

  private clearBadgeSubs() {
    this.commentCountSubs.forEach(s => s.unsubscribe());
    this.attachmentCountSubs.forEach(s => s.unsubscribe());
    this.commentCountSubs.clear();
    this.attachmentCountSubs.clear();
  }

  isLoadingProblems = true;
  loadError: string | null = null;

  isEditor$!: Observable<boolean>;
  isOnline$!: Observable<boolean>;              // ★ 追加
  canEdit$!: Observable<boolean>;               // ★ 追加

  selectedNode: TreeNode | null = null;
  comments$?: Observable<CommentDoc[]>;
  newBody = '';
  editingId: string | null = null;

  attachmentCounts: Partial<Record<string, number>> = {};

  // 合計（コメント + 添付）
  totalCount(id: string) {
    return (this.commentCounts[id] ?? 0) + (this.attachmentCounts[id] ?? 0);
  }

  // コメント件数バッジ（node.id -> count）
  commentCounts: Partial<Record<string, number>> = {};

  data: TreeNode[] = [];
  tree = new NestedTreeControl<TreeNode>(n => n.children ?? []);
  private subForTree?: import('rxjs').Subscription;

  private issueSubs = new Map<string, import('rxjs').Subscription>(); // problemId -> sub
  private taskSubs  = new Map<string, import('rxjs').Subscription>(); // `${problemId}_${issueId}` -> sub

  attachments$?: Observable<AttachmentDoc[]>;
  uploadBusy = false;

  // TreePage クラス内の他の Map 群の近くに追加
private commentCountSubs   = new Map<string, import('rxjs').Subscription>();
private attachmentCountSubs = new Map<string, import('rxjs').Subscription>();

  // ==== 添付ファイルのクライアントバリデーション ====
private readonly MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
private readonly ALLOWED_MIME = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf'
];
private readonly ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'];

private isAllowedFile(file: File): { ok: boolean; reason?: string } {
  const sizeOk = file.size <= this.MAX_FILE_BYTES;
  if (!sizeOk) return { ok: false, reason: `「${file.name}」は20MBを超えています` };

  // MIME が空のことがある（環境/拡張子次第）ので、拡張子も見て二重判定
  const mimeOk = !!file.type && this.ALLOWED_MIME.includes(file.type.toLowerCase());
  const name = file.name.toLowerCase();
  const extOk = this.ALLOWED_EXT.some(ext => name.endsWith(ext));

  if (!(mimeOk || extOk)) {
    return { ok: false, reason: `「${file.name}」は対応していない形式です（画像 or PDF）` };
  }
  return { ok: true };
}


  constructor(
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    public auth: AuthService,
    private currentProject: CurrentProjectService,
    public members: MembersService,
    private comments: CommentsService,
    private snack: MatSnackBar,
    private drafts: DraftsService,
    private network: NetworkService, 
    private tr: TranslateService,
    private attachments: AttachmentsService,
  ) {
    this.isEditor$ = this.members.isEditor$;
    this.isOnline$ = this.network.isOnline$;
    this.canEdit$ = combineLatest([this.members.isEditor$, this.network.isOnline$]).pipe(
      map(([isEditor, online]) => !!isEditor && !!online)
    );
  }

  // ===== 既存メソッド（ガード追加） =====
  async renameProblemNode(node: { id: string; name: string }) {
    if (!(await this.requireCanEdit())) return;
    const t = prompt(this.tr.instant('tree.prompt.renameProblem'), node.name);
    if (!t?.trim()) return;
    this.withPid(pid => this.problems.update(pid, node.id, { title: t.trim() }));
  }
  async removeProblemNode(node: { id: string; name: string }) {
    if (!(await this.requireCanEdit())) return;
    if (!confirm(this.tr.instant('tree.confirm.deleteProblem', { name: node.name }))) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('problem', { projectId: pid, problemId: node.id }, '(Problem)');
    });
  }
  async renameIssueNode(node: { id: string; name: string; parentId?: string }) {
    if (!node.parentId) return;
    if (!(await this.requireCanEdit())) return;
    const t = prompt(this.tr.instant('tree.prompt.renameIssue'), node.name);
    if (!t?.trim()) return;
    this.withPid(pid => this.issues.update(pid, node.parentId!, node.id, { title: t.trim() }));
  }
  async removeIssueNode(node: { id: string; name: string; parentId?: string }) {
    if (!node.parentId) return;
    if (!(await this.requireCanEdit())) return;
    if (!confirm(this.tr.instant('tree.confirm.deleteIssue', { name: node.name }))) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('issue', { projectId: pid, problemId: node.parentId!, issueId: node.id }, node.name);
    });
  }
  async renameTaskNode(node: { id: string; name: string; parentProblemId?: string; parentIssueId?: string }) {
    if (!node.parentProblemId || !node.parentIssueId) return;
    if (!(await this.requireCanEdit())) return;
    const t = prompt(this.tr.instant('tree.prompt.renameTask'), node.name);
    if (!t?.trim()) return;
    this.withPid(pid => this.tasks.update(pid, node.parentProblemId!, node.parentIssueId!, node.id, { title: t.trim() }));
  }
  async removeTaskNode(node: { id: string; name: string; parentProblemId?: string; parentIssueId?: string }) {
    if (!node.parentProblemId || !node.parentIssueId || this.isBusyId(node.id)) return;
    if (!(await this.requireCanEdit())) return;
    if (!confirm(this.tr.instant('tree.confirm.deleteTask', { name: node.name }))) return;
    this.busyIds.add(node.id!);
    this.withPid(async pid => {
      try {
        await this.softDeleteWithUndo(
          'task',
          { projectId: pid, problemId: node.parentProblemId!, issueId: node.parentIssueId!, taskId: node.id! },
          node.name
        );
      } finally {
        this.busyIds.delete(node.id!);
      }
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
        this.clearBadgeSubs();
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
          await Promise.all(this.data.map(async n => {
            // 先に単発ロード（既存）：初期表示を速く
            await Promise.all([ this.loadCountFor(n), this.loadAttachCountFor(n) ]);
            // 続いてリアルタイム購読
            await this.attachBadgeStreams(n);
          }));
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
    if (this.commentSaveTimer) { clearTimeout(this.commentSaveTimer); this.commentSaveTimer = null; }
    this.commentCountSubs.forEach(s => s.unsubscribe());
    this.attachmentCountSubs.forEach(s => s.unsubscribe());
    this.commentCountSubs.clear();
    this.attachmentCountSubs.clear();
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
        // 親 Problem
        await this.attachBadgeStreams(pNode);
        // 子 Issue
        await Promise.all(kids.map(k => this.attachBadgeStreams(k)));
      } catch {}
      
      // --- 不要になった件数購読の掃除（Issue が減った場合） ---
      const aliveIssueIds = new Set(kids.map(k => k.id));
      for (const [id, sub] of this.commentCountSubs.entries()) {
        if (id !== pNode.id && !aliveIssueIds.has(id) && (this.data.findIndex(n => n.id === id) === -1)) {
          sub.unsubscribe(); this.commentCountSubs.delete(id);
        }
      }
      for (const [id, sub] of this.attachmentCountSubs.entries()) {
        if (id !== pNode.id && !aliveIssueIds.has(id) && (this.data.findIndex(n => n.id === id) === -1)) {
          sub.unsubscribe(); this.attachmentCountSubs.delete(id);
        }
      }

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
            // 当該 Issue
            await this.attachBadgeStreams(issueNode);
            // 子 Task
            await Promise.all(kids.map(k => this.attachBadgeStreams(k)));
          } catch {}
          
          // --- 不要になった件数購読の掃除（Task が減った場合） ---
          const aliveTaskIds = new Set(kids.map(k => k.id));
          for (const [id, sub] of this.commentCountSubs.entries()) {
            // 当該 Issue 配下の Task で生きていないものを掃除
            if (!aliveTaskIds.has(id) && this.data.every(p => (p.children ?? []).every(i => (i.children ?? []).every(t => t.id !== id)))) {
              sub.unsubscribe(); this.commentCountSubs.delete(id);
            }
          }
          for (const [id, sub] of this.attachmentCountSubs.entries()) {
            if (!aliveTaskIds.has(id) && this.data.every(p => (p.children ?? []).every(i => (i.children ?? []).every(t => t.id !== id)))) {
              sub.unsubscribe(); this.attachmentCountSubs.delete(id);
            }
          }
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
      labels: [this.tr.instant('tree.open'), this.tr.instant('tree.done')],
      datasets: [{ data: [open, done] }]
    } as ChartConfiguration<'doughnut'>['data'];
  }
  barData(d: { overdue: number; today: number; thisWeek: number; nextWeek: number; later: number; nodue: number; }) {
    return {
      labels: [
        this.tr.instant('tree.overdue'),
        this.tr.instant('tree.today'),
        this.tr.instant('tree.thisWeek'),
        this.tr.instant('tree.nextWeek'),
        this.tr.instant('tree.later'),
        this.tr.instant('tree.noDue'),
      ],
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
  // 共通パターン（TreePage / HomePage 両方）
  private withPid(run: (pid: string) => void) {
    this.currentProject.projectId$.pipe(take(1)).subscribe(pid => {
      if (!pid || pid === 'default') {
        alert('プロジェクト未選択');
        return;
      }
      run(pid);
    });
  }

   private async toAttachmentTarget(node: TreeNode): Promise<AttachmentTarget | null> {
       // 実体の形は同じなので型を合わせて返す
       const t = await this.toTarget(node);
       return (t as unknown) as AttachmentTarget | null;
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

  startEdit(id: string, current: string){
    this.editingId = id;
    this.newBody = current;
  }

  async deleteComment(id: string){
    if (!(await this.requireCanEdit())) return;
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

  private async loadAttachCountFor(node: TreeNode) {
    const t = await this.toAttachmentTarget(node);
    if (!t) return;
    try {
      const n = await firstValueFrom(this.attachments.list(t).pipe(take(1)));
      this.attachmentCounts[node.id] = n.length;
    } catch {}
  }
  
  // 添付件数を即時反映（+1 / -1）
  private bumpAttachCount(node: TreeNode | null, delta: number) {
    if (!node) return;
    const prev = this.attachmentCounts[node.id] ?? 0;
    this.attachmentCounts[node.id] = Math.max(0, prev + delta);
  }
  

  private bumpCount(node: TreeNode | null, delta: number) {
    if (!node) return;
    const prev = this.commentCounts[node.id] ?? 0;
    this.commentCounts[node.id] = Math.max(0, prev + delta);
  }

  // ---- コメントのドラフト（既存） ----
  private commentSaveTimer: any = null;

  private draftKeyFor(node: TreeNode | null): string | null {
    const pid = this.currentProject.getSync();
    if (!pid || !node) return null;
    if (node.kind === 'problem') return `comment:${pid}:p:${node.id}`;
    if (node.kind === 'issue')   return `comment:${pid}:i:${node.parentId}:${node.id}`;
    return `comment:${pid}:t:${node.parentProblemId}:${node.parentIssueId}:${node.id}`;
  }

  onCommentBodyChange(val: string) {
    // 600ms デバウンスで localStorage に保存
    if (this.commentSaveTimer) clearTimeout(this.commentSaveTimer);
    this.commentSaveTimer = setTimeout(() => {
      const key = this.draftKeyFor(this.selectedNode);
      if (key) this.drafts.set(key, (val ?? '').toString());
    }, 600);
  }

  // コメントターゲット切替時に下書き復元を提案
  async openComments(node: TreeNode){
    this.selectedNode = node;
    const t = await this.toTarget(node);
    if (!t) { this.comments$ = undefined; return; }
    this.comments$ = this.comments.listByTarget(t, 50);
    this.editingId = null;

    // 一旦クリアしてからドラフト復元
    this.newBody = '';

    const key = this.draftKeyFor(node);
    if (key) {
      const rec = this.drafts.get<string>(key);
      if (rec && (!this.newBody || this.newBody.trim() === '')) {
        const ok = confirm('未投稿の下書きが見つかりました。復元しますか？');
        if (ok) this.newBody = rec.value || '';
      }
    }
    // 添付一覧 ーーーーーーーーーーーーーーーーーー
    const at = await this.toAttachmentTarget(node);
    this.attachments$ = at ? this.attachments.list(at) : undefined;

  }

  // 投稿/更新/キャンセル時はドラフトを消す
  async addComment(){
    if (!(await this.requireCanEdit())) return;
    if (this.commentSaveTimer) { clearTimeout(this.commentSaveTimer); this.commentSaveTimer = null; }
    if (!this.selectedNode || !this.newBody.trim()) return;
    const t = await this.toTarget(this.selectedNode); if (!t) return;

    const uid = await firstValueFrom(this.auth.uid$);
    const name = await firstValueFrom(this.auth.displayName$);
    await this.comments.create(t, this.newBody.trim(), uid!, name || undefined);
    const key = this.draftKeyFor(this.selectedNode);
    if (key) this.drafts.clear(key);    // ← クリア
    this.newBody = '';
  }

  async saveEdit(){
    if (!(await this.requireCanEdit())) return;
    if (this.commentSaveTimer) { clearTimeout(this.commentSaveTimer); this.commentSaveTimer = null; }
    const node = this.selectedNode; if (!node || !this.editingId || !this.newBody.trim()) return;
    const t = await this.toTarget(node); if (!t) return;
    await this.comments.update(t, this.editingId, this.newBody.trim());
    const key = this.draftKeyFor(node);
    if (key) this.drafts.clear(key);    // ← クリア
    this.editingId = null;
    this.newBody = '';
  }

  cancelEdit(){
    this.editingId = null;
    // 編集キャンセルでもドラフトは保持したいので newBody は残す／クリアしない
  }

  /** 共通：ソフトデリート → Undo 5秒 */
  private async softDeleteWithUndo(
    kind: 'problem'|'issue'|'task',
    path: { projectId: string; problemId?: string; issueId?: string; taskId?: string },
    titleForToast: string
  ){
    const uid = await firstValueFrom(this.auth.uid$);
    const patch = { softDeleted: true, deletedAt: serverTimestamp() as any, updatedBy: uid || '' } as any;

    if (kind === 'problem') {
      await this.problems.update(path.projectId, path.problemId!, patch);
    } else if (kind === 'issue') {
      await this.issues.update(path.projectId, path.problemId!, path.issueId!, patch);
    } else {
      await this.tasks.update(path.projectId, path.problemId!, path.issueId!, path.taskId!, patch);
    }

    const ref = this.snack.open(`「${titleForToast}」を削除しました`, '元に戻す', { duration: 5000 });
    ref.onAction().subscribe(async () => {
      const unpatch = { softDeleted: false, deletedAt: null, updatedBy: uid || '' } as any;
      if (kind === 'problem') {
        await this.problems.update(path.projectId, path.problemId!, unpatch);
      } else if (kind === 'issue') {
        await this.issues.update(path.projectId, path.problemId!, path.issueId!, unpatch);
      } else {
        await this.tasks.update(path.projectId, path.problemId!, path.issueId!, path.taskId!, unpatch);
      }
    });
  }

  // ===== オンライン/権限ガード =====
  private async requireCanEdit(): Promise<boolean> {
    const [isEditor, online] = await Promise.all([
      firstValueFrom(this.members.isEditor$),
      firstValueFrom(this.isOnline$),
    ]);
    if (!isEditor) {
      this.snack.open(this.tr.instant('warn.noEditPermission'), 'OK', { duration: 3000 });
      return false;
    }
    if (!online) {
      this.snack.open(this.tr.instant('warn.offlineNoEdit'), 'OK', { duration: 3000 });
      return false;
    }
    return true;
  }

  async onPickFiles(ev: Event) {
    if (!(await this.requireCanEdit())) return;
  
    const input = ev.target as HTMLInputElement;
    const selected = Array.from(input.files || []);
    if (!selected.length || !this.selectedNode) return;
  
    // バリデーション
    const valids: File[] = [];
    const errors: string[] = [];
    for (const f of selected) {
      const r = this.isAllowedFile(f);
      if (r.ok) valids.push(f);
      else if (r.reason) errors.push(r.reason);
    }
  
    if (errors.length) {
      // まとめてユーザーにフィードバック
      this.snack.open(errors.join(' / '), 'OK', { duration: 5000 });
    }
    if (!valids.length) {
      // 1つも通らなければ終了
      if (input) input.value = '';
      return;
    }
  
    const t = await this.toAttachmentTarget(this.selectedNode);
    if (!t) return;
  
    const uid = await firstValueFrom(this.auth.uid$);
    this.uploadBusy = true;
  
    try {
      // 複数ファイルを順番にアップロード
      for (const f of valids) {
        await this.attachments.upload(t, f, uid || '', (pct) => {
          // 必要なら進捗表示：console.log(`[upload] ${f.name}: ${pct}%`);
        });
        this.bumpAttachCount(this.selectedNode, +1);
        ;
      }
      this.snack.open(this.tr.instant('common.uploadDone') || 'アップロードしました', 'OK', { duration: 2500 });
    } catch (e: any) {
      console.error(e);
      const msg =
        e?.code === 'storage/unauthorized' ? '権限がありません' :
        e?.code === 'storage/canceled'     ? 'アップロードがキャンセルされました' :
        e?.code === 'storage/retry-limit-exceeded' ? 'アップロードに失敗しました（再試行上限）' :
        this.tr.instant('common.uploadFailed') || 'アップロードに失敗しました';
      this.snack.open(msg, 'OK', { duration: 4000 });
    } finally {
      this.uploadBusy = false;
      if (input) input.value = '';
    }
  }
  
  
  async removeAttachment(a: AttachmentDoc) {
    if (!(await this.requireCanEdit())) return;
    if (!this.selectedNode) return;
    const ok = confirm(`「${a.name}」を削除しますか？`);
    if (!ok) return;
  
    const t = await this.toAttachmentTarget(this.selectedNode);
    if (!t || !a.id) return;
    try {
      await this.attachments.remove(t, a.id, a.storagePath);
      this.bumpAttachCount(this.selectedNode, -1);
    } catch (e) {
      console.error(e);
      this.snack.open(this.tr.instant('common.deleteFailed') || '削除に失敗しました', 'OK', { duration: 3000 });
    }
  }
  
  // TreePage クラス内に追加
private async attachBadgeStreams(node: TreeNode) {
  // ---- コメント件数 ----
  try {
    const t = await this.toTarget(node);
    if (t) {
      this.commentCountSubs.get(node.id)?.unsubscribe();
      const subC = this.comments
        // ここは件数上限を広めに（サービス側の第二引数が limit の想定）
        .listByTarget(t, 1000)
        .pipe(map(arr => arr.length))
        .subscribe(n => { this.commentCounts[node.id] = n; });
      this.commentCountSubs.set(node.id, subC);
    }
  } catch {}

  // ---- 添付件数 ----
  try {
    const at = await this.toAttachmentTarget(node);
    if (at) {
      this.attachmentCountSubs.get(node.id)?.unsubscribe();
      const subA = this.attachments
        .list(at) // 添付は list(at) が Observable<AttachmentDoc[]>
        .pipe(map(arr => arr.length))
        .subscribe(n => { this.attachmentCounts[node.id] = n; });
      this.attachmentCountSubs.set(node.id, subA);
    }
  } catch {}
}

}

