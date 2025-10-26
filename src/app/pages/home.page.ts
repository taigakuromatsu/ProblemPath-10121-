// src/app/pages/home.page.ts
import { Component, DestroyRef } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, NgFor, NgIf, JsonPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { PrefsService } from '../services/prefs.service';
import { ThemeService } from '../services/theme.service';
import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { AuthService } from '../services/auth.service';
import { MembersService } from '../services/members.service';
import { InvitesService, InviteRole } from '../services/invites.service';

import { Problem, Issue, Task } from '../models/types';
import { Observable, BehaviorSubject, of, combineLatest, firstValueFrom } from 'rxjs';
import { switchMap, take, map, startWith } from 'rxjs/operators';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { serverTimestamp } from 'firebase/firestore';

// ---- このページ専用の拡張型（ProblemにproblemDefをオプションで持たせる）----
type ProblemWithDef = Problem & {
  problemDef?: {
    phenomenon: string;
    goal: string;
    cause?: string;
    solution?: string;
    updatedAt?: any;   // Firestore Timestamp を想定
    updatedBy?: string;
  };
};

// ---- リンク種別（types.ts を更新していなくても使えるようローカル定義）----
type LinkType = 'relates' | 'duplicate' | 'blocks' | 'depends_on' | 'same_cause';
const LINK_TYPE_LABEL: Record<LinkType, string> = {
  relates: '関連',
  duplicate: '重複',
  blocks: 'ブロック',
  depends_on: '依存',
  same_cause: '同一原因',
};

@Component({
  standalone: true,
  selector: 'pp-home',
  imports: [
    RouterLink, AsyncPipe, NgFor, NgIf, JsonPipe, DatePipe, FormsModule,
    MatButtonModule, MatSelectModule, MatIconModule, MatSnackBarModule
  ],
  template: `
    <h2>Home</h2>

    <div style="display:flex; align-items:center; gap:12px; margin:8px 0;">
      <span style="flex:1 1 auto;"></span>
      <ng-container *ngIf="auth.loggedIn$ | async; else signin">
        <span style="opacity:.8; margin-right:6px;">{{ (auth.displayName$ | async) || 'signed in' }}</span>
        <button mat-stroked-button type="button" (click)="auth.signOut()">Sign out</button>
      </ng-container>
      <ng-template #signin>
        <button mat-raised-button color="primary" type="button" (click)="auth.signInWithGoogle()">Sign in with Google</button>
        <button mat-stroked-button type="button" (click)="switchAccount()">Switch account</button>
      </ng-template>
    </div>

    <div *ngIf="(auth.loggedIn$ | async) && !(members.isEditor$ | async)"
         style="padding:8px 10px; border:1px solid #e5e7eb; border-radius:8px; background:#fafafa; margin:8px 0; font-size:12px;">
      現在のプロジェクトでは <strong>閲覧のみ（Viewer）</strong> です。編集ボタンは非表示になります。
    </div>

    <p>ここで Problem を選んで、その配下の Issue / Task を編集します。</p>

    <ng-container *ngIf="auth.loggedIn$ | async; then editor; else needSignIn"></ng-container>

    <ng-template #needSignIn>
      <div style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin:12px 0;">
        編集にはサインインが必要です。右上の「Sign in」からログインしてください。<br>
        閲覧は <a routerLink="/tree">Tree</a> / <a routerLink="/board">Board</a> / <a routerLink="/schedule">Schedule</a> で可能です。
      </div>
    </ng-template>

    <ng-template #editor>
      <nav style="margin-bottom:12px;">
        <a routerLink="/tree">🌳 Tree</a> |
        <a routerLink="/board">📋 Board</a> |
        <a routerLink="/schedule">📆 Schedule</a>
      </nav>

      <!-- Problem セレクト（＋新規作成… は Editor のみ表示） -->
      <div style="display:flex; align-items:center; gap:12px; margin:8px 0 12px;">
        <label>Problem:
          <select [(ngModel)]="selectedProblemId" (ngModelChange)="onSelectProblem($event)">
            <option [ngValue]="null">-- 選択してください --</option>
            <option *ngFor="let p of (problems$ | async)" [ngValue]="p.id">{{ p.title }}</option>
            <option *ngIf="members.isEditor$ | async" [ngValue]="NEW_OPTION_VALUE">＋ 新規作成…</option>
          </select>
        </label>

        <!-- 新規 Problem 作成モーダル -->
        <div *ngIf="newProblemOpen"
            style="position:fixed; inset:0; display:grid; place-items:center; background:rgba(0,0,0,.35); z-index:1000;">
          <div style="width:min(720px, 92vw); background:#fff; color:#111; border-radius:12px; padding:14px 16px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <h3 style="margin:0; font-size:16px;">Problem を作成</h3>
              <span style="flex:1 1 auto"></span>
              <button mat-icon-button (click)="closeNewProblemDialog()"><mat-icon>close</mat-icon></button>
            </div>

            <div style="display:grid; gap:10px;">
              <div>
                <label>タイトル（必須）</label>
                <input [(ngModel)]="newProblem.title" style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;" />
              </div>

              <div style="display:flex; gap:8px; align-items:center;">
                <label>テンプレ</label>
                <select [(ngModel)]="newProblem.template" (ngModelChange)="applyProblemTemplate($event)">
                  <option value="bug">バグ/不具合</option>
                  <option value="improve">改善/パフォーマンス</option>
                </select>
              </div>

              <div>
                <label>現象（必須）</label>
                <textarea rows="3" [(ngModel)]="newProblem.phenomenon"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
                <div style="opacity:.7; font-size:12px; margin-top:4px;">
                  何が起きている？再現手順・ユーザー影響・発生率 など
                </div>
              </div>

              <div>
                <label>原因（任意）</label>
                <textarea rows="3" [(ngModel)]="newProblem.cause"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>解決策（任意）</label>
                <textarea rows="3" [(ngModel)]="newProblem.solution"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>目標（必須）</label>
                <textarea rows="2" [(ngModel)]="newProblem.goal"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
                <div style="opacity:.7; font-size:12px; margin-top:4px;">
                  どうなればOK？KPI・条件（例：p50 1.5秒 / エラー率0.1%未満）
                </div>
              </div>

              <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:4px;">
                <button mat-stroked-button (click)="closeNewProblemDialog()">キャンセル</button>
                <button mat-raised-button color="primary" (click)="createProblemWithDefinition()">作成</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Problem 定義：編集モーダル -->
        <div *ngIf="editProblemOpen"
            style="position:fixed; inset:0; display:grid; place-items:center; background:rgba(0,0,0,.35); z-index:1000;">
          <div style="width:min(720px, 92vw); background:#fff; color:#111; border-radius:12px; padding:14px 16px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <h3 style="margin:0; font-size:16px;">Problem 定義を編集</h3>
              <span style="flex:1 1 auto"></span>
              <button mat-icon-button (click)="closeEditProblemDialog()"><mat-icon>close</mat-icon></button>
            </div>

            <div style="display:grid; gap:10px;">
              <div>
                <label>タイトル（参照）</label>
                <input [value]="editProblem.title" readonly
                      style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px; background:#f7f7f7;">
              </div>

              <div>
                <label>現象（必須）</label>
                <textarea rows="3" [(ngModel)]="editProblem.phenomenon"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>原因（任意）</label>
                <textarea rows="3" [(ngModel)]="editProblem.cause"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>解決策（任意）</label>
                <textarea rows="3" [(ngModel)]="editProblem.solution"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>目標（必須）</label>
                <textarea rows="2" [(ngModel)]="editProblem.goal"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:4px;">
                <button mat-stroked-button (click)="closeEditProblemDialog()">キャンセル</button>
                <button mat-raised-button color="primary" (click)="saveEditedProblemDef()">保存</button>
              </div>
            </div>
          </div>
        </div>

        <span style="flex:1 1 auto"></span>

        <ng-container *ngIf="members.isEditor$ | async">
          <button *ngIf="selectedProblemId" mat-stroked-button (click)="renameSelected()">Rename</button>
          <button *ngIf="selectedProblemId" mat-stroked-button color="warn" (click)="removeSelected()">Delete</button>
        </ng-container>
      </div>

      <!-- 選択中 Problem の情報（problemDef） -->
      <ng-container *ngIf="selectedProblemId as pid">
        <div *ngIf="selectedProblemDoc$ | async as p"
             style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:12px;">
          <h3 style="margin:0 0 8px; display:flex; align-items:center; gap:8px;">
            <span>Problem 定義</span>
            <span style="flex:1 1 auto;"></span>
            <button *ngIf="members.isEditor$ | async"
                    mat-stroked-button
                    (click)="openEditProblemDef(p)">
              Edit
            </button>
          </h3>
          <div style="display:grid; gap:6px; font-size:14px;">
            <div><span style="font-weight:600;">現象：</span>
              <span>{{ p.problemDef?.phenomenon || '—' }}</span>
            </div>
            <div *ngIf="p.problemDef?.cause"><span style="font-weight:600;">原因：</span>
              <span>{{ p.problemDef?.cause }}</span>
            </div>
            <div *ngIf="p.problemDef?.solution"><span style="font-weight:600;">解決策：</span>
              <span>{{ p.problemDef?.solution }}</span>
            </div>
            <div><span style="font-weight:600;">目標：</span>
              <span>{{ p.problemDef?.goal || '—' }}</span>
            </div>
            <div style="opacity:.65; font-size:12px; margin-top:4px;"
                *ngIf="getUpdatedAtDate(p) as d">
              最終更新：{{ d | date:'yyyy/MM/dd HH:mm' }}
            </div>
          </div>
        </div>

        <!-- Issues + Link UI -->
        <div style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:16px;">
          <h3 style="margin:0 0 8px;">Issues</h3>

          <form *ngIf="members.isEditor$ | async"
                (ngSubmit)="createIssue(pid)"
                style="display:flex; gap:8px; align-items:center; margin:8px 0;">
            <input [(ngModel)]="issueTitle" name="issueTitle" placeholder="New Issue title" required />
            <button mat-raised-button color="primary" type="submit">＋ Add Issue</button>
          </form>

          <ul *ngIf="issues$ | async as issues; else loadingIssues" style="margin:0; padding-left:1rem;">
            <li *ngFor="let i of issues" style="margin-bottom:12px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <strong>{{ i.title }}</strong>
                <span style="flex:1 1 auto"></span>
                <ng-container *ngIf="members.isEditor$ | async">
                  <button mat-button (click)="renameIssue(pid, i)">Rename</button>
                  <button mat-button color="warn" (click)="removeIssue(pid, i)">Delete</button>
                </ng-container>
              </div>

              <!-- Link list -->
              <div style="margin:6px 0 2px 0; font-size:13px;">
                <span style="font-weight:600;">Links：</span>
                <ng-container *ngIf="(visibleLinks(i.links, issues).length) > 0; else noLinks">
                  <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:4px;">
                    <ng-container *ngFor="let lk of visibleLinks(i.links, issues)">
                      <span style="border:1px solid #e5e7eb; border-radius:999px; padding:2px 8px; background:#fafafa;">
                        <span style="opacity:.85;">[{{ linkLabel(lk.type) }}]</span>
                        <span> {{ titleByIssueId(issues, lk.issueId) }} </span>
                        <button *ngIf="members.isEditor$ | async"
                                mat-icon-button
                                aria-label="Remove link"
                                (click)="onRemoveLink(pid, i.id!, lk.issueId, lk.type)"
                                style="vertical-align:middle; margin-left:2px;">
                          <mat-icon style="font-size:16px;">close</mat-icon>
                        </button>
                      </span>
                    </ng-container>
                  </div>
                </ng-container>
                <ng-template #noLinks><span style="opacity:.7;">（リンクなし）</span></ng-template>
              </div>


              <!-- Link add form (Editor only) -->
              <form *ngIf="members.isEditor$ | async"
                    (ngSubmit)="onAddLink(pid, i.id!)"
                    style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0 4px 0;">
                <select [(ngModel)]="linkTarget[i.id!]" name="linkTarget-{{i.id}}" style="min-width:180px;">
                  <option [ngValue]="null">-- 対象 Issue を選択 --</option>
                  <option *ngFor="let j of issues" [ngValue]="j.id" [disabled]="j.id===i.id">
                    {{ j.title }}
                  </option>
                </select>
                <select [(ngModel)]="linkTypeSel[i.id!]" name="linkType-{{i.id}}" style="min-width:140px;">
                  <option *ngFor="let t of linkTypes" [ngValue]="t">{{ linkLabel(t) }}</option>
                </select>
                <button mat-stroked-button type="submit">＋ Link</button>
              </form>

              <!-- Tasks -->
              <form *ngIf="members.isEditor$ | async"
                    (ngSubmit)="createTask(pid, i.id!)"
                    style="display:flex; gap:6px; margin:6px 0 4px 0;">
                <input [(ngModel)]="taskTitle[i.id!]" name="taskTitle-{{i.id}}" placeholder="New Task title" required />
                <button mat-stroked-button type="submit">＋ Add Task</button>
              </form>

              <ul *ngIf="tasksMap[i.id!] | async as tasks" style="margin:0; padding-left:1rem;">
                <li *ngFor="let t of tasks" style="margin:3px 0;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <span style="flex:1 1 auto;">
                      {{ t.title }}
                      <span *ngIf="t.dueDate" style="font-size:12px; opacity:.8; margin-left:6px;">(due: {{ t.dueDate }})</span>
                      <span style="font-size:12px; opacity:.85; margin-left:6px;">
                        <ng-container *ngIf="(t.tags?.length ?? 0) > 0; else noTags">
                          #{{ t.tags!.join(' #') }}
                        </ng-container>
                        <ng-template #noTags>（タグなし）</ng-template>
                      </span>
                    </span>

                    <ng-container *ngIf="members.isEditor$ | async">
                      <button mat-button (click)="renameTask(pid, i.id!, t)">Rename</button>
                      <button mat-button (click)="editTaskDue(pid, i.id!, t)">Due</button>
                      <button mat-button (click)="editTaskTags(pid, i.id!, t)">Tags</button>
                      <button mat-button color="warn" (click)="removeTask(pid, i.id!, t)">Delete</button>
                    </ng-container>
                  </div>
                </li>
                <li *ngIf="tasks.length === 0" style="opacity:.7">（Taskはまだありません）</li>
              </ul>
            </li>
            <li *ngIf="issues.length === 0" style="opacity:.7">（Issueはまだありません）</li>
          </ul>
          <ng-template #loadingIssues>Loading issues...</ng-template>
        </div>
      </ng-container>

      <!-- === 招待（Adminのみ） === -->
      <div *ngIf="(members.isAdmin$ | async)" style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin:12px 0;">
        <h3 style="margin:0 0 8px;">Invite by Email</h3>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <input [(ngModel)]="inviteEmail" placeholder="email@example.com"
                style="padding:6px 8px; border:1px solid #e5e7eb; border-radius:6px; min-width:240px;">
          <select [(ngModel)]="inviteRole">
            <option value="admin">admin</option>
            <option value="member" selected>member</option>
            <option value="viewer">viewer</option>
          </select>
          <button mat-raised-button color="primary" (click)="createInvite()" [disabled]="isCreatingInvite">
            {{ isCreatingInvite ? 'Creating...' : 'Create invite link' }}
          </button>
          <ng-container *ngIf="inviteUrl">
            <input [value]="inviteUrl" readonly
                  style="flex:1 1 auto; padding:6px 8px; border:1px solid #e5e7eb; border-radius:6px;">
            <button mat-stroked-button (click)="copyInviteUrl()">Copy</button>
          </ng-container>
        </div>
        <p style="opacity:.7; margin-top:6px;">生成されたURLをメールで送ってください。相手は開いてログイン→「参加する」でメンバーになります。</p>
      </div>

      <!-- --- Settings 表示（従来のまま） --- -->
      <section style="margin-top:16px;">
        <h3>Settings (準備のみ／表示)</h3>
        <p style="opacity:.75; margin:0 0 8px;">
          将来ここで「性格タイプ／言語／テーマ／アクセント色」を編集します。今は下地だけ入っています。
        </p>
        <pre style="padding:8px; border:1px solid #eee; border-radius:8px; background:#fafafa;">
{{ (prefs.prefs$ | async) | json }}
        </pre>
      </section>
      
      <!-- 追加：テーマ設定 UI -->
      <section style="margin-top:16px;">
        <h3>テーマ設定</h3>

        <mat-form-field appearance="outline" style="min-width:240px; width:100%; max-width:360px; margin-top:8px;">
          <mat-label>テーマを選択</mat-label>
          <mat-select [(ngModel)]="themeMode" (selectionChange)="onThemeChange($event.value)">
            <mat-option value="light">ライト</mat-option>
            <mat-option value="dark">ダーク</mat-option>
            <mat-option value="system">システムに合わせる</mat-option>
          </mat-select>
          <mat-icon matSuffix>expand_more</mat-icon>
        </mat-form-field>

      </section>

    </ng-template>
  `
})
export class HomePage {
  readonly NEW_OPTION_VALUE = '__NEW__';

  problems$!: Observable<Problem[]>;
  selectedProblemId: string | null = null;

  private selectedProblem$ = new BehaviorSubject<string | null>(null);
  issues$: Observable<Issue[] | null> = of(null);

  // Problem 定義表示用
  selectedProblemDoc$!: Observable<ProblemWithDef | null>;

  issueTitle = '';
  taskTitle: Record<string, string> = {}; // key = issueId
  tasksMap: Record<string, Observable<Task[]>> = {};

  // --- Link UI state ---
  linkTypes: LinkType[] = ['relates','duplicate','blocks','depends_on','same_cause'];
  linkTarget: Record<string, string | null> = {};      // issueId -> targetIssueId
  linkTypeSel: Record<string, LinkType> = {};          // issueId -> selected type

  constructor(
    public prefs: PrefsService,
    private theme: ThemeService,
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    private destroyRef: DestroyRef,
    public auth: AuthService,
    private currentProject: CurrentProjectService,
    public members: MembersService,
    private invites: InvitesService,
    private snack: MatSnackBar
  ) {}

  themeMode: 'light' | 'dark' | 'system' = 'system';

  ngOnInit() {
    // テーマ反映（既存）
    this.prefs.prefs$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(p => {
        this.themeMode = (p?.theme ?? 'system') as any;
      });

    // サインアウト時の掃除
    this.auth.loggedIn$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(isIn => {
        if (!isIn) {
          this.currentProject.set(null);
          this.selectedProblemId = null;
          this.selectedProblem$.next(null);
          this.tasksMap = {};
        }
      });

    // Problems（pid 必須）
    this.problems$ = combineLatest([this.auth.loggedIn$, this.currentProject.projectId$]).pipe(
      switchMap(([isIn, pid]) => (isIn && pid && pid !== 'default') ? this.problems.list(pid) : of([]))
    );

    // 選択中 Problem の Doc（problemDef 表示用）
    this.selectedProblemDoc$ = combineLatest([
      this.problems$.pipe(startWith([] as Problem[])),
      this.selectedProblem$
    ]).pipe(map(([list, sel]) => (list as ProblemWithDef[]).find(p => p.id === sel) ?? null));

    // Issues（選択 Problem × pid）
    this.issues$ = combineLatest([
      this.selectedProblem$,
      this.auth.loggedIn$,
      this.currentProject.projectId$
    ]).pipe(
      switchMap(([pidProblem, isIn, pid]) =>
        (isIn && pid && pid !== 'default' && pidProblem) ? this.issues.listByProblem(pid, pidProblem) : of([])
      )
    );

    // Issue → Task購読キャッシュ
    this.issues$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(issues => {
        if (!this.selectedProblemId) {
          this.tasksMap = {};
          return;
        }
        const nextMap: Record<string, Observable<Task[]>> = {};
        for (const i of issues ?? []) {
          const id = i.id!;
          nextMap[id] = this.tasksMap[id] ?? this.currentProject.projectId$.pipe(
            switchMap(pid => (pid && pid !== 'default') ? this.tasks.listByIssue(pid, this.selectedProblemId!, id) : of([]))
          );

          // link UI 初期値
          if (!this.linkTypeSel[id]) this.linkTypeSel[id] = 'relates';
          if (!(id in this.linkTarget)) this.linkTarget[id] = null;
        }
        this.tasksMap = nextMap;
      });
  }

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

  onSelectProblem(val: string | null) {
    if (val === this.NEW_OPTION_VALUE) {
      this.selectedProblemId = null;
      this.selectedProblem$.next(null);
      this.openNewProblemDialog();
      return;
    }
    this.selectedProblemId = val;
    this.selectedProblem$.next(val);
  }

  // --- Problem 操作 ---
  renameSelected() {
    if (!this.selectedProblemId) return;
    const t = prompt('New Problem title');
    if (!t?.trim()) return;
    this.withPid(pid => this.problems.update(pid, this.selectedProblemId!, { title: t.trim() }));
  }
  removeSelected() {
    if (!this.selectedProblemId) return;
    if (!confirm('Delete this Problem (and all children)?')) return;  // ← 確認は一旦踏襲
    const problemId = this.selectedProblemId!;
    this.withPid(async pid => {
      // 実削除からソフトデリートに変更
      await this.softDeleteWithUndo('problem', { projectId: pid, problemId }, '(Problem)');
      // UI上は消えるので選択解除（Undo しても一覧に復帰する）
      this.selectedProblemId = null;
      this.selectedProblem$.next(null);
    });
  }
  

  // --- Issue 操作 ---
  createIssue(problemId: string) {
    const t = this.issueTitle.trim();
    if (!t) return;
    this.withPid(pid => this.issues.create(pid, problemId, { title: t }).then(() => this.issueTitle = ''));
  }
  renameIssue(problemId: string, i: Issue) {
    const t = prompt('New Issue title', i.title);
    if (!t?.trim()) return;
    this.withPid(pid => this.issues.update(pid, problemId, i.id!, { title: t.trim() }));
  }
  removeIssue(problemId: string, i: Issue) {
    if (!confirm(`Delete Issue "${i.title}"?`)) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('issue', { projectId: pid, problemId, issueId: i.id! }, i.title);
    });
  }
  

  // === Link 操作 ===
  linkLabel(t: LinkType) { return LINK_TYPE_LABEL[t] || t; }

  titleByIssueId(all: Issue[], id?: string | null): string | null {
    if (!id) return null;
    const hit = all?.find(x => x.id === id);
    return hit?.title ?? null;
  }

  async onAddLink(problemId: string, fromIssueId: string) {
    const toIssueId = this.linkTarget[fromIssueId];
    const type = this.linkTypeSel[fromIssueId] || 'relates';
    if (!toIssueId) { alert('対象 Issue を選んでください'); return; }
    if (toIssueId === fromIssueId) { alert('同一 Issue にはリンクできません'); return; }
    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }
    const uid = await firstValueFrom(this.auth.uid$);
    await this.issues.addLink(pid, problemId, fromIssueId, toIssueId, type, uid || '');
    // フォームをリセット
    this.linkTarget[fromIssueId] = null;
    this.linkTypeSel[fromIssueId] = 'relates';
  }

  async onRemoveLink(problemId: string, fromIssueId: string, toIssueId: string, type: LinkType) {
    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }
    await this.issues.removeLink(pid, problemId, fromIssueId, toIssueId, type);
  }

  // --- Task 操作 ---
  createTask(problemId: string, issueId: string) {
    const t = (this.taskTitle[issueId] ?? '').trim();
    if (!t) return;
    this.withPid(pid => this.tasks.create(pid, problemId, issueId, { title: t }).then(() => {
      this.taskTitle[issueId] = '';
    }));
  }
  renameTask(problemId: string, issueId: string, task: Task) {
    const t = prompt('New Task title', task.title);
    if (!t?.trim()) return;
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, task.id!, { title: t.trim() }));
  }
  removeTask(problemId: string, issueId: string, t: Task) {
    if (!confirm(`Delete Task "${t.title}"?`)) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('task', { projectId: pid, problemId, issueId, taskId: t.id! }, t.title);
    });
  }
  

  // 期日・タグ編集
  editTaskDue(problemId: string, issueId: string, t: Task) {
    const cur = t.dueDate ?? '';
    const nxt = prompt('Due (YYYY-MM-DD、空で解除)', cur ?? '');
    if (nxt === null) return;
    const dueDate = (nxt.trim() === '') ? null : nxt.trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      alert('日付は YYYY-MM-DD 形式で入力してください');
      return;
    }
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, t.id!, { dueDate }));
  }
  editTaskTags(problemId: string, issueId: string, t: Task) {
    const current = (t.tags ?? []).join(', ');
    const input = prompt('Tags (カンマ/スペース区切り)\n例: バグ, UI  または  バグ UI', current ?? '');
    if (input == null) return;
    const tags = input.split(/[, \s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean);
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, t.id!, { tags }));
  }

  async switchAccount() {
    await this.auth.signOut();
    await this.auth.signInWithGoogle(true);
  }

  // 招待
  inviteEmail = '';
  inviteRole: InviteRole = 'member';
  inviteUrl: string | null = null;
  isCreatingInvite = false;

  async createInvite() {
    if (!this.inviteEmail.trim()) return;
    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }
    this.isCreatingInvite = true;
    try {
      const url = await this.invites.create(pid, this.inviteEmail.trim(), this.inviteRole);
      this.inviteUrl = url;
    } finally {
      this.isCreatingInvite = false;
    }
  }
  copyInviteUrl() {
    if (this.inviteUrl) navigator.clipboard.writeText(this.inviteUrl);
  }

  // テーマ
  onThemeChange(mode: 'light' | 'dark' | 'system') {
    this.theme.setTheme(mode);
    if ((this.prefs as any).update) {
      (this.prefs as any).update({ theme: mode });
    } else {
      localStorage.setItem('pp.theme', mode);
    }
    this.themeMode = mode;
  }

  get systemPrefersDark(): boolean {
    return typeof window !== 'undefined'
      && !!window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  get themeModeLabel(): string {
    if (this.themeMode === 'system') {
      return this.systemPrefersDark ? 'システム（ダーク）' : 'システム（ライト）';
    }
    return this.themeMode === 'dark' ? 'ダーク' : 'ライト';
  }

  // 新規Problemダイアログ用状態
  newProblemOpen = false;
  newProblem = {
    title: '',
    phenomenon: '',
    cause: '',
    solution: '',
    goal: '',
    template: 'bug' as 'bug' | 'improve'
  };

  // 編集ダイアログ用
  editProblemOpen = false;
  editProblem = {
    title: '',        // 表示用（編集はしない）
    phenomenon: '',
    cause: '',
    solution: '',
    goal: ''
  };

  applyProblemTemplate(kind: 'bug' | 'improve') {
    this.newProblem.template = kind;
    if (kind === 'bug') {
      this.newProblem.phenomenon ||= '（例）保存ボタンを押してもトーストが出ず、再読み込みで初めて反映される';
      this.newProblem.goal      ||= '（例）保存操作は1秒以内にユーザーへ成功が伝わる（トースト表示／二重送信防止）';
    } else {
      this.newProblem.phenomenon ||= '（例）ダッシュボード初回表示が5秒以上かかる';
      this.newProblem.goal        ||= '（例）p50 1.5秒 / p95 3秒以下';
    }
  }

  openNewProblemDialog() {
    this.newProblemOpen = true;
    this.applyProblemTemplate(this.newProblem.template);
  }
  closeNewProblemDialog() {
    this.newProblemOpen = false;
    this.newProblem = { title: '', phenomenon: '', cause: '', solution: '', goal: '', template: 'bug' };
  }

  // 追加：保存処理（validation → Firestore へ）
  async createProblemWithDefinition() {
    const p = this.newProblem;

    const errs: string[] = [];
    if (!p.title.trim()) errs.push('タイトルは必須です');
    if (!p.phenomenon.trim()) errs.push('現象は必須です');
    if (!p.goal.trim()) errs.push('目標は必須です');
    const over = (s: string, n: number) => s && s.length > n;
    if (over(p.title, 200)) errs.push('タイトルは200文字以内にしてください');
    if (over(p.phenomenon, 1000)) errs.push('現象は1000文字以内にしてください');
    if (over(p.cause, 1000)) errs.push('原因は1000文字以内にしてください');
    if (over(p.solution, 1000)) errs.push('解決策は1000文字以内にしてください');
    if (over(p.goal, 500)) errs.push('目標は500文字以内にしてください');

    if (errs.length) { alert(errs.join('\n')); return; }

    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }

    const uid = await firstValueFrom(this.auth.uid$);
    const payload: any = {
      title: p.title.trim(),
      template: { kind: p.template },
      problemDef: {
        phenomenon: p.phenomenon.trim(),
        goal: p.goal.trim(),
        updatedBy: uid || ''
      }
    };
    const cause = p.cause.trim();
    const solution = p.solution.trim();
    if (cause) payload.problemDef.cause = cause;         // 空なら送らない
    if (solution) payload.problemDef.solution = solution;
    
    const ref = await this.problems.create(pid, payload);  

    this.selectedProblemId = (ref as any)?.id ?? null;
    this.selectedProblem$.next(this.selectedProblemId);
    this.closeNewProblemDialog();
  }

  // Firestore Timestamp / Date / null を安全に Date|null へ
  getUpdatedAtDate(p: ProblemWithDef): Date | null {
    const ts: any = p?.problemDef?.updatedAt;
    if (!ts) return null;
    try {
      if (typeof ts.toDate === 'function') return ts.toDate(); // Firestore Timestamp
      if (ts instanceof Date) return ts;                       // 既に Date
    } catch {}
    return null;
  }

  // Problem 定義 編集モーダルを開く
  openEditProblemDef(p: ProblemWithDef) {
    this.editProblemOpen = true;
    this.editProblem = {
      title: p.title ?? '',
      phenomenon: p.problemDef?.phenomenon ?? '',
      cause: p.problemDef?.cause ?? '',
      solution: p.problemDef?.solution ?? '',
      goal: p.problemDef?.goal ?? '',
    };
  }

  // 閉じる
  closeEditProblemDialog() {
    this.editProblemOpen = false;
  }

  // 保存
  async saveEditedProblemDef() {
    const pid = this.currentProject.getSync();
    if (!pid || !this.selectedProblemId) { alert('プロジェクト/Problem未選択'); return; }

    const d = this.editProblem;

    // 簡易バリデーション（作成時と同等）
    const errs: string[] = [];
    if (!d.phenomenon.trim()) errs.push('現象は必須です');
    if (!d.goal.trim()) errs.push('目標は必須です');
    const over = (s: string, n: number) => s && s.length > n;
    if (over(d.phenomenon, 1000)) errs.push('現象は1000文字以内にしてください');
    if (over(d.cause, 1000)) errs.push('原因は1000文字以内にしてください');
    if (over(d.solution, 1000)) errs.push('解決策は1000文字以内にしてください');
    if (over(d.goal, 500)) errs.push('目標は500文字以内にしてください');
    if (errs.length) { alert(errs.join('\n')); return; }

    const uid = await firstValueFrom(this.auth.uid$);
    await this.problems.updateProblemDef(pid, this.selectedProblemId, {
      phenomenon: d.phenomenon.trim(),
      goal: d.goal.trim(),
      cause: d.cause.trim(),
      solution: d.solution.trim(),
      updatedBy: uid || '',
    });

    this.closeEditProblemDialog();
  }

  // クラス内メソッドとして追加
visibleLinks(raw: any, all: Issue[] | null | undefined): { issueId: string, type: LinkType }[] {
  if (!Array.isArray(raw) || !Array.isArray(all)) return [];
  const set = new Set(all.map(i => i.id));
  return raw
    .filter(v => v && typeof v === 'object' && v.issueId && v.type)
    .filter(v => set.has(String(v.issueId)))          // ← 相手が存在するものだけ
    .map(v => ({ issueId: String(v.issueId), type: v.type as LinkType }));
}


// home.page.ts 内クラスに追加

/** 共通：ソフトデリート → Undo 5秒 */
private async softDeleteWithUndo(
  kind: 'problem'|'issue'|'task',
  path: { projectId: string; problemId?: string; issueId?: string; taskId?: string },
  title: string
){
  const uid = await firstValueFrom(this.auth.uid$);

  // それぞれに応じて update を発行
  const patch = { softDeleted: true, deletedAt: (serverTimestamp as any)(), updatedBy: uid || '' } as any;

  if (kind === 'problem') {
    await this.problems.update(path.projectId, path.problemId!, patch);
  } else if (kind === 'issue') {
    await this.issues.update(path.projectId, path.problemId!, path.issueId!, patch);
  } else {
    await this.tasks.update(path.projectId, path.problemId!, path.issueId!, path.taskId!, patch);
  }

  const ref = this.snack.open(`「${title}」を削除しました`, '元に戻す', { duration: 5000 });
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

}


