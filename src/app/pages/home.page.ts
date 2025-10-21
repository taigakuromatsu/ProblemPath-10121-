// src/app/pages/home.page.ts
import { Component, DestroyRef } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, NgFor, NgIf, JsonPipe } from '@angular/common';
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
import { MembersService } from '../services/members.service'; // ★ 追加
import { InvitesService, InviteRole } from '../services/invites.service';

import { Problem, Issue, Task } from '../models/types';
import { Observable, BehaviorSubject, of, combineLatest } from 'rxjs';
import { switchMap, tap, take } from 'rxjs/operators';
import { map } from 'rxjs/operators';

@Component({
  standalone: true,
  selector: 'pp-home',
  imports: [
    RouterLink, AsyncPipe, NgFor, NgIf, JsonPipe, FormsModule,
    MatButtonModule, MatSelectModule, MatIconModule
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

    <!-- ビューアーモードのバッジ -->
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

        <span style="flex:1 1 auto"></span>

        <ng-container *ngIf="members.isEditor$ | async">
          <button *ngIf="selectedProblemId" mat-stroked-button (click)="renameSelected()">Rename</button>
          <button *ngIf="selectedProblemId" mat-stroked-button color="warn" (click)="removeSelected()">Delete</button>
        </ng-container>
      </div>

      <!-- 選択中 Problem の編集パネル -->
      <ng-container *ngIf="selectedProblemId as pid">
        <div style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:16px;">
          <h3 style="margin:0 0 8px;">Issues</h3>

          <!-- Issue 追加（Editor のみ） -->
          <form *ngIf="members.isEditor$ | async"
                (ngSubmit)="createIssue(pid)"
                style="display:flex; gap:8px; align-items:center; margin:8px 0;">
            <input [(ngModel)]="issueTitle" name="issueTitle" placeholder="New Issue title" required />
            <button mat-raised-button color="primary" type="submit">＋ Add Issue</button>
          </form>

          <!-- Issue 一覧 -->
          <ul *ngIf="issues$ | async as issues; else loadingIssues" style="margin:0; padding-left:1rem;">
            <li *ngFor="let i of issues" style="margin-bottom:10px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <strong>{{ i.title }}</strong>
                <span style="flex:1 1 auto"></span>
                <ng-container *ngIf="members.isEditor$ | async">
                  <button mat-button (click)="renameIssue(pid, i)">Rename</button>
                  <button mat-button color="warn" (click)="removeIssue(pid, i)">Delete</button>
                </ng-container>
              </div>

              <!-- Task 追加（Issueごと・Editor のみ） -->
              <form *ngIf="members.isEditor$ | async"
                    (ngSubmit)="createTask(pid, i.id!)"
                    style="display:flex; gap:6px; margin:6px 0 4px 0;">
                <input [(ngModel)]="taskTitle[i.id!]" name="taskTitle-{{i.id}}" placeholder="New Task title" required />
                <button mat-stroked-button type="submit">＋ Add Task</button>
              </form>

              <!-- Task 一覧 -->
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

        <!-- 2行目：選択UI（はっきりした枠とラベル） -->
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

  issueTitle = '';
  taskTitle: Record<string, string> = {}; // key = issueId
  tasksMap: Record<string, Observable<Task[]>> = {};

  constructor(
    public prefs: PrefsService,
    private theme: ThemeService,
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    private destroyRef: DestroyRef,
    public auth: AuthService,
    private currentProject: CurrentProjectService,
    public members: MembersService, // ★ 追加（template から参照するため public）
    private invites: InvitesService
  ) {}


  themeMode: 'light' | 'dark' | 'system' = 'system';

  ngOnInit() {
    // テーマ反映（既存）
    this.prefs.prefs$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(p => {
        this.themeMode = (p?.theme ?? 'system') as any;   // ← UIへ反映
        });

    // サインアウト時の掃除だけ（プロジェクトIDは AuthService.ensureOnboard がセット）
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

    // Issue → Task購読キャッシュ（pid 追従、未ログイン/未選択時は掃除）
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
        }
        this.tasksMap = nextMap;
      });
  }

  // ヘルパー：一度だけ pid を取り出して実行
  private withPid(run: (pid: string) => void) {
    this.currentProject.projectId$.pipe(take(1)).subscribe(pid => {
      if (!pid) { alert('プロジェクト未選択'); return; }
      run(pid);
    });
  }

  onSelectProblem(val: string | null) {
    if (val === this.NEW_OPTION_VALUE) {
      const t = prompt('New Problem title');
      if (!t?.trim()) {
        this.selectedProblemId = null;
        this.selectedProblem$.next(null);
        return;
      }
      this.withPid(async pid => {
        const ref = await this.problems.create(pid, { title: t.trim() });
        this.selectedProblemId = (ref as any)?.id ?? null;
        this.selectedProblem$.next(this.selectedProblemId);
      });
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
    if (!confirm('Delete this Problem (and all children)?')) return;
    const id = this.selectedProblemId!;
    this.withPid(async pid => {
      await this.problems.remove(pid, id);
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
    this.withPid(pid => this.issues.remove(pid, problemId, i.id!));
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
  removeTask(problemId: string, issueId: string, task: Task) {
    if (!confirm(`Delete Task "${task.title}"?`)) return;
    this.withPid(pid => this.tasks.remove(pid, problemId, issueId, task.id!));
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

    // 選択されたときに即適用＋永続化
  onThemeChange(mode: 'light' | 'dark' | 'system') {
    // 即時反映
    this.theme.setTheme(mode);

    // 永続化（PrefsService に setter があるならそちらを優先）
    // 1) PrefsService に update メソッドがある場合（例）
    if ((this.prefs as any).update) {
      (this.prefs as any).update({ theme: mode });
    } else {
      // 2) 一時的に localStorage に保存（次回起動用のフォールバック）
      localStorage.setItem('pp.theme', mode);
    }

    // UI も更新
    this.themeMode = mode;
  }

  // HomePage クラス内に追加
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


}

