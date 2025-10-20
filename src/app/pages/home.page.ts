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
import { Problem, Issue, Task } from '../models/types';
import { Observable, BehaviorSubject, of, combineLatest } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';
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
      </ng-template>
    </div>

    <p>ここで Problem を選んで、その配下の Issue / Task を編集します。</p>

<ng-container *ngIf="auth.loggedIn$ | async; then editor; else needSignIn"></ng-container>

        <ng-template #needSignIn>
      <div style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin:12px 0;">
        編集にはサインインが必要です。右上の「Sign in」からログインしてください。<br>
        閲覧は <a routerLink="/tree">Tree</a> / <a routerLink="/board">Board</a> / <a routerLink="/schedule">Schedule</a> で可能です。
      </div>
    </ng-template>

    <!-- 未ログイン時は案内だけ出す -->
    <ng-template #editor>
      <nav style="margin-bottom:12px;">
        <a routerLink="/tree">🌳 Tree</a> |
        <a routerLink="/board">📋 Board</a> |
        <a routerLink="/schedule">📆 Schedule</a>
      </nav>

      <!-- Problem セレクト（＋新規作成… を内包） -->
      <div style="display:flex; align-items:center; gap:12px; margin:8px 0 12px;">
        <label>Problem:
          <select [(ngModel)]="selectedProblemId" (ngModelChange)="onSelectProblem($event)">
            <option [ngValue]="null">-- 選択してください --</option>
            <option *ngFor="let p of (problems$ | async)" [ngValue]="p.id">{{ p.title }}</option>
            <option [ngValue]="NEW_OPTION_VALUE">＋ 新規作成…</option>
          </select>
        </label>

        <span style="flex:1 1 auto"></span>

        <button *ngIf="selectedProblemId" mat-stroked-button (click)="renameSelected()">Rename</button>
        <button *ngIf="selectedProblemId" mat-stroked-button color="warn" (click)="removeSelected()">Delete</button>
      </div>

    <!-- 選択中 Problem の編集パネル -->
    <ng-container *ngIf="selectedProblemId as pid">
      <div style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:16px;">
        <h3 style="margin:0 0 8px;">Issues</h3>

        <!-- Issue 追加 -->
        <form (ngSubmit)="createIssue(pid)" style="display:flex; gap:8px; align-items:center; margin:8px 0;">
          <input [(ngModel)]="issueTitle" name="issueTitle" placeholder="New Issue title" required />
          <button mat-raised-button color="primary" type="submit">＋ Add Issue</button>
        </form>

        <!-- Issue 一覧 -->
        <ul *ngIf="issues$ | async as issues; else loadingIssues" style="margin:0; padding-left:1rem;">
          <li *ngFor="let i of issues" style="margin-bottom:10px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <strong>{{ i.title }}</strong>
              <span style="flex:1 1 auto"></span>
              <button mat-button (click)="renameIssue(pid, i)">Rename</button>
              <button mat-button color="warn" (click)="removeIssue(pid, i)">Delete</button>
            </div>

            <!-- Task 追加（Issueごと） -->
            <form (ngSubmit)="createTask(pid, i.id!)" style="display:flex; gap:6px; margin:6px 0 4px 0;">
              <input [(ngModel)]="taskTitle[i.id!]" name="taskTitle-{{i.id}}" placeholder="New Task title" required />
              <button mat-stroked-button type="submit">＋ Add Task</button>
            </form>

            <!-- Task 一覧（最小の編集：タイトル/期限/タグ/削除） -->
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

                  <button mat-button (click)="renameTask(pid, i.id!, t)">Rename</button>
                  <button mat-button (click)="editTaskDue(pid, i.id!, t)">Due</button>
                  <button mat-button (click)="editTaskTags(pid, i.id!, t)">Tags</button>
                  <button mat-button color="warn" (click)="removeTask(pid, i.id!, t)">Delete</button>
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
  // 追加：IssueID -> Observable<Task[]> のキャッシュ
  tasksMap: Record<string, Observable<Task[]>> = {};

  constructor(
    public prefs: PrefsService,
    private theme: ThemeService,
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    private destroyRef: DestroyRef,
    public auth: AuthService
  ) {}
  
    ngOnInit() {
      // テーマ反映（既存）
      this.prefs.prefs$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(p => this.theme.apply(p.theme, p.accentColor));
  
      // 未ログイン時は空配列にする
      this.problems$ = this.auth.loggedIn$.pipe(
        switchMap(isIn => isIn ? this.problems.list() : of([]))
      );
  
      // 選択 Problem の Issue 一覧（未ログイン/未選択は空）
      this.issues$ = combineLatest([this.selectedProblem$, this.auth.loggedIn$]).pipe(
        switchMap(([pid, isIn]) => (isIn && pid) ? this.issues.listByProblem(pid) : of([]))
      );
  
      // Issue → Task購読キャッシュ（未ログイン・未選択時は掃除）
      this.issues$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(issues => {
          const isIn = (this.authSnapshot = this.authSnapshot ?? false); // フィールドに最後の状態を持たせる
          // auth.loggedIn$ は下で購読して更新します（↓）
  
          if (!this.selectedProblemId) {
            this.tasksMap = {};
            return;
          }
          const nextMap: Record<string, Observable<Task[]>> = {};
          for (const i of issues ?? []) {
            const id = i.id!;
            nextMap[id] = this.tasksMap[id] ?? this.tasks.listByIssue(this.selectedProblemId!, id);
          }
          this.tasksMap = nextMap;
        });
  
      // ログイン状態のスナップショットとサインアウト時のリセット
      this.auth.loggedIn$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(isIn => {
          this.authSnapshot = isIn;
          if (!isIn) {
            this.selectedProblemId = null;
            this.selectedProblem$.next(null);
            this.tasksMap = {};
          }
        });
    }
  
    // 任意：メソッド側の保険（UIガードだけで十分なら不要）
    private authSnapshot = false;
    private requireLogin(): boolean {
      if (!this.authSnapshot) {
        alert('この操作にはサインインが必要です');
        return false;
      }
      return true;
    }
  
    onSelectProblem(val: string | null) {
      if (val === this.NEW_OPTION_VALUE) {
        if (!this.requireLogin()) return;
        const t = prompt('New Problem title');
        if (!t || !t.trim()) {
          this.selectedProblemId = null;
          this.selectedProblem$.next(null);
          return;
        }
        this.problems.create({ title: t.trim() }).then(docRef => {
          this.selectedProblemId = (docRef as any)?.id ?? null;
          this.selectedProblem$.next(this.selectedProblemId);
        });
        return;
      }
      if (!this.requireLogin() && val) return; // 未ログイン時の選択操作を無効化（nullに戻すならこの行は省略）
      this.selectedProblemId = val;
      this.selectedProblem$.next(val);
    }
  

  // --- Problem 操作 ---
  async renameSelected() {
    if (!this.selectedProblemId) return;
    const t = prompt('New Problem title');
    if (t && t.trim()) await this.problems.update(this.selectedProblemId, { title: t.trim() });
  }
  async removeSelected() {
    if (!this.selectedProblemId) return;
    if (confirm('Delete this Problem (and all children)?')) {
      await this.problems.remove(this.selectedProblemId);
      this.selectedProblemId = null;
      this.selectedProblem$.next(null);
    }
  }

  // --- Issue 操作 ---
  async createIssue(problemId: string) {
    const t = this.issueTitle.trim();
    if (!t) return;
    await this.issues.create(problemId, { title: t });
    this.issueTitle = '';
  }
  async renameIssue(problemId: string, i: Issue) {
    const t = prompt('New Issue title', i.title);
    if (t && t.trim()) await this.issues.update(problemId, i.id!, { title: t.trim() });
  }
  async removeIssue(problemId: string, i: Issue) {
    if (confirm(`Delete Issue "${i.title}"?`)) await this.issues.remove(problemId, i.id!);
  }


  async createTask(problemId: string, issueId: string) {
    const t = (this.taskTitle[issueId] ?? '').trim();
    if (!t) return;
    await this.tasks.create(problemId, issueId, { title: t });
    this.taskTitle[issueId] = '';
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

  // 期日・タグ編集（Tree と同じ挙動）
  async editTaskDue(problemId: string, issueId: string, t: Task) {
    const cur = t.dueDate ?? '';
    const nxt = prompt('Due (YYYY-MM-DD、空で解除)', cur ?? '');
    if (nxt === null) return;
    const dueDate = (nxt.trim() === '') ? null : nxt.trim();
    await this.tasks.update(problemId, issueId, t.id!, { dueDate });
  }
  async editTaskTags(problemId: string, issueId: string, t: Task) {
    const current = (t.tags ?? []).join(', ');
    const input = prompt('Tags (カンマ/スペース区切り)\n例: バグ, UI  または  バグ UI', current ?? '');
    if (input == null) return;
    const tags = input.split(/[, \s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean);
    await this.tasks.update(problemId, issueId, t.id!, { tags });
  }
}
