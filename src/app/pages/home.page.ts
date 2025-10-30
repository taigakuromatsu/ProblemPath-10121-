import { Component, DestroyRef, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, NgFor, NgIf, JsonPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
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
import { Observable, BehaviorSubject, of, combineLatest, firstValueFrom, Subscription } from 'rxjs';
import { switchMap, take, map, startWith } from 'rxjs/operators';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { serverTimestamp } from 'firebase/firestore';
import { DraftsService } from '../services/drafts.service';
import { NetworkService } from '../services/network.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MessagingService, FcmNotice } from '../services/messaging.service';
import { Firestore, doc, docData } from '@angular/fire/firestore';
import { MatDividerModule } from '@angular/material/divider';
import { AiIssueSuggestComponent } from '../components/ai-issue-suggest.component';
import { TranslatePipe } from '@ngx-translate/core';

// ---- このページ専用の拡張型 ----
type ProblemWithDef = Problem & {
  problemDef?: {
    phenomenon: string;
    goal: string;
    cause?: string;
    solution?: string;
    updatedAt?: any;
    updatedBy?: string;
  };
};
type EditProblemField = 'phenomenon' | 'cause' | 'solution' | 'goal';

// ---- リンク種別 ----
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
    MatButtonModule, MatSelectModule, MatFormFieldModule, MatIconModule, 
    MatCardModule, MatChipsModule, MatSnackBarModule, TranslateModule,
    MatDividerModule, AiIssueSuggestComponent
  ],
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss']
})
export class HomePage implements OnInit, OnDestroy {
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

  // Link UI state
  linkTypes: LinkType[] = ['relates','duplicate','blocks','depends_on','same_cause'];
  linkTarget: Record<string, string | null> = {};
  linkTypeSel: Record<string, LinkType> = {};

  // Draft timers
  private issueTitleTimer: any = null;
  private taskTitleTimers: Record<string, any> = {};
  private newProblemTimers: Partial<Record<'title'|'phenomenon'|'cause'|'solution'|'goal'|'template', any>> = {};
  private editProblemTimers: Partial<Record<EditProblemField, any>> = {};

  // ネットワーク
  isOnline$!: Observable<boolean>;
  canEdit$!: Observable<boolean>;

  // --- FCM（フォアグラウンド表示用） ---
  fcmToken: string | null = null; // UIには出さないが、権限許可直後の確認用に保持のみ
  fgMessages: Array<{ title?: string; body?: string }> = [];
  private fgSub?: Subscription;

  // --- FCM 状態（users/{uid}/fcmStatus/app） ---
  fcmStatus$!: Observable<{ enabled?: boolean; lastTokenSavedAt?: any; lastError?: string } | null>;

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
    private snack: MatSnackBar,
    private drafts: DraftsService,
    private network: NetworkService,
    private msg: MessagingService,
    private fs: Firestore,
    private i18n: TranslateService,
  ) {
    this.isOnline$ = this.network.isOnline$;
    this.canEdit$ = combineLatest([this.members.isEditor$, this.network.isOnline$]).pipe(
      map(([isEditor, online]) => !!isEditor && !!online)
    );
  }

  /** 翻訳キーが未登録の時に fallback を返す */
  t(key: string, fallback: string): string {
    const v = this.i18n.instant(key);
    return v === key ? fallback : v;
  }

  onLangChange(next: 'ja' | 'en') {
    this.prefs.update({ lang: next });
  }

  lang: 'ja' | 'en' = 'ja';

  themeMode: 'light' | 'dark' | 'system' = 'system';

  async ngOnInit() {
    // テーマ反映
    this.prefs.prefs$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(p => {
        this.themeMode = (p?.theme ?? 'system') as any;
        this.lang = (p?.lang === 'en' ? 'en' : 'ja');
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

    // 選択中 Problem の Doc
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

    // Issue → Task購読 + ドラフト復元 + Link UI 初期化
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

          // Task タイトルのドラフト復元
          const keyT = this.draftKeyTaskTitle(this.selectedProblemId, id);
          const recT = keyT ? this.drafts.get<string>(keyT) : null;
          if (recT && !this.taskTitle[id]) {
            this.taskTitle[id] = recT.value || '';
          }

          // Link UI 初期値
          if (!this.linkTypeSel[id]) this.linkTypeSel[id] = 'relates';
          if (!(id in this.linkTarget)) this.linkTarget[id] = null;
        }
        this.tasksMap = nextMap;
      });

    // --- FCM: 既に権限があればトークン取得＆保存（UI表示はしない） ---
    try {
      this.fcmToken = await this.msg.getTokenIfGranted();
    } catch {}

    // フォアグラウンド通知の購読（最新20件）
    this.fgSub = this.msg.onMessage$.subscribe((n: FcmNotice) => {
      this.fgMessages = [{ title: n?.title, body: n?.body }, ...this.fgMessages].slice(0, 20);
    });

    // FCM 状態の購読（enabled / lastError など） — AngularFireの doc() を使用（警告回避）
    this.fcmStatus$ = this.auth.uid$.pipe(
      switchMap(uid => uid ? docData(doc(this.fs, `users/${uid}/fcmStatus/app`)) : of(null))
    ) as any;
  }

  // 通知の権限リクエスト → トークン取得 → Firestore 保存
  async askNotificationPermission() {
    try {
      const t = await this.msg.requestPermissionAndGetToken();
      this.fcmToken = t; // UIは出さないが状態保持のみ
      this.snack.open('通知を有効化しました', undefined, { duration: 2000 });
    } catch (e: any) {
      console.error('[FCM] permission/token error', e);
      this.snack.open('通知の有効化に失敗しました', undefined, { duration: 2500 });
    }
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
    if (!(await this.requireOnline())) return;
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

  onSelectProblem(val: string | null) {
    if (val === this.NEW_OPTION_VALUE) {
      this.selectedProblemId = null;
      this.selectedProblem$.next(null);
      this.openNewProblemDialog();
      return;
    }
    this.selectedProblemId = val;
    this.selectedProblem$.next(val);

    // Issue タイトルのドラフト復元
    const key = this.draftKeyIssueTitle(val);
    if (key) {
      const rec = this.drafts.get<string>(key);
      if (rec && !this.issueTitle) {
        const ok = confirm('Issue タイトルの下書きがあります。復元しますか？');
        if (ok) this.issueTitle = rec.value || '';
      }
    }
  }

  // 共通 withPid
  private withPid(run: (pid: string) => void) {
    this.currentProject.projectId$.pipe(take(1)).subscribe(pid => {
      if (!pid || pid === 'default') {
        alert('プロジェクト未選択');
        return;
      }
      run(pid);
    });
  }

  // オンライン必須ガード
  private async requireOnline(): Promise<boolean> {
    const online = await firstValueFrom(this.isOnline$);
    if (!online) {
      alert('オフラインのため、この操作は実行できません。接続を確認してください。');
      return false;
    }
    return true;
  }

  // --- Issue タイトルのドラフト ---
  private draftKeyIssueTitle(problemId: string | null): string | null {
    const pid = this.currentProject.getSync();
    if (!pid || !problemId) return null;
    return `issueTitle:${pid}:${problemId}`;
  }
  onIssueTitleChange(val: string) {
    if (this.issueTitleTimer) clearTimeout(this.issueTitleTimer);
    this.issueTitleTimer = setTimeout(() => {
      const key = this.draftKeyIssueTitle(this.selectedProblemId);
      if (key) this.drafts.set(key, (val ?? '').toString());
    }, 600);
  }

  // --- Problem 操作 ---
  async renameSelected() {
    if (!this.selectedProblemId) return;
    if (!(await this.requireOnline())) return;
    const t = prompt('New Problem title');
    if (!t?.trim()) return;
    this.withPid(pid => this.problems.update(pid, this.selectedProblemId!, { title: t.trim() }));
  }
  async removeSelected() {
    if (!this.selectedProblemId) return;
    if (!(await this.requireOnline())) return;
    if (!confirm('Delete this Problem (and all children)?')) return;
    const problemId = this.selectedProblemId!;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('problem', { projectId: pid, problemId }, '(Problem)');
      this.selectedProblemId = null;
      this.selectedProblem$.next(null);
    });
  }

  // --- Issue 操作 ---
  async createIssue(problemId: string) {
    if (!(await this.requireOnline())) return;
    const t = this.issueTitle.trim();
    if (!t) return;
    this.withPid(pid => this.issues.create(pid, problemId, { title: t }).then(() => {
      this.issueTitle = '';
      const key = this.draftKeyIssueTitle(this.selectedProblemId);
      if (key) this.drafts.clear(key);
    }));
  }
  async renameIssue(problemId: string, i: Issue) {
    if (!(await this.requireOnline())) return;
    const t = prompt('New Issue title', i.title);
    if (!t?.trim()) return;
    this.withPid(pid => this.issues.update(pid, problemId, i.id!, { title: t.trim() }));
  }
  async removeIssue(problemId: string, i: Issue) {
    if (!(await this.requireOnline())) return;
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
    if (!(await this.requireOnline())) return;
    const toIssueId = this.linkTarget[fromIssueId];
    const type = this.linkTypeSel[fromIssueId] || 'relates';
    if (!toIssueId) { alert('対象 Issue を選んでください'); return; }
    if (toIssueId === fromIssueId) { alert('同一 Issue にはリンクできません'); return; }
    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }
    const uid = await firstValueFrom(this.auth.uid$);
    await this.issues.addLink(pid, problemId, fromIssueId, toIssueId, type, uid || '');
    this.linkTarget[fromIssueId] = null;
    this.linkTypeSel[fromIssueId] = 'relates';
  }
  async onRemoveLink(problemId: string, fromIssueId: string, toIssueId: string, type: LinkType) {
    if (!(await this.requireOnline())) return;
    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }
    await this.issues.removeLink(pid, problemId, fromIssueId, toIssueId, type);
  }

  // --- Task タイトルのドラフト ---
  private draftKeyTaskTitle(problemId: string | null, issueId: string): string | null {
    const pid = this.currentProject.getSync();
    if (!pid || !problemId) return null;
    return `taskTitle:${pid}:${problemId}:${issueId}`;
  }
  onTaskTitleChange(issueId: string, val: string) {
    const k = this.draftKeyTaskTitle(this.selectedProblemId, issueId);
    if (!k) return;
    if (this.taskTitleTimers[issueId]) clearTimeout(this.taskTitleTimers[issueId]);
    this.taskTitleTimers[issueId] = setTimeout(() => {
      this.drafts.set(k, (val ?? '').toString());
    }, 600);
  }

  async createTask(problemId: string, issueId: string) {
    if (!(await this.requireOnline())) return;
    const t = (this.taskTitle[issueId] ?? '').trim();
    if (!t) return;
    this.withPid(pid => this.tasks.create(pid, problemId, issueId, { title: t }).then(() => {
      this.taskTitle[issueId] = '';
      const key = this.draftKeyTaskTitle(this.selectedProblemId, issueId);
      if (key) this.drafts.clear(key);
    }));
  }
  async renameTask(problemId: string, issueId: string, task: Task) {
    if (!(await this.requireOnline())) return;
    const t = prompt('New Task title', task.title);
    if (!t?.trim()) return;
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, task.id!, { title: t.trim() }));
  }
  async removeTask(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
    if (!confirm(`Delete Task "${t.title}"?`)) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('task', { projectId: pid, problemId, issueId, taskId: t.id! }, t.title);
    });
  }

  // 期日・タグ編集
  async editTaskDue(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
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
  async editTaskTags(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
    const current = (t.tags ?? []).join(', ');
    const input = prompt('Tags (カンマ/スペース区切り)\n例: バグ, UI  または  バグ UI', current ?? '');
    if (input == null) return;
    const tags = input.split(/[, \s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean);
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, t.id!, { tags }));
  }

  // --- Problem 作成/編集ドラフト: キー関数 ---
  private draftKeyNewProblem(): string | null {
    const pid = this.currentProject.getSync();
    if (!pid) return null;
    return `problem:new:${pid}`;
  }
  private draftKeyEditProblem(problemId: string | null): string | null {
    const pid = this.currentProject.getSync();
    if (!pid || !problemId) return null;
    return `problem:edit:${pid}:${problemId}`;
  }

  // --- Problem 作成ドラフト: 変更ハンドラ ---
  onNewProblemChange<K extends keyof typeof this.newProblem>(field: K, _val: (typeof this.newProblem)[K]) {
    const key = this.draftKeyNewProblem(); if (!key) return;
    if (this.newProblemTimers[field]) clearTimeout(this.newProblemTimers[field]);
    this.newProblemTimers[field] = setTimeout(() => {
      this.drafts.set(key, JSON.stringify(this.newProblem));
    }, 600);
  }

  // --- Problem 編集ドラフト: 変更ハンドラ ---
  onEditProblemChange<K extends EditProblemField>(field: K, _val: (typeof this.editProblem)[K]) {
    const key = this.draftKeyEditProblem(this.selectedProblemId); if (!key) return;
    if (this.editProblemTimers[field]) clearTimeout(this.editProblemTimers[field]!);
    this.editProblemTimers[field] = setTimeout(() => {
      this.drafts.set(key, JSON.stringify(this.editProblem));
    }, 600);
  }

  visibleLinks(raw: any, all: Issue[] | null | undefined): { issueId: string, type: LinkType }[] {
    if (!Array.isArray(raw) || !Array.isArray(all)) return [];
    const set = new Set(all.map(i => i.id));
    return raw
      .filter((v: any) => v && typeof v === 'object' && v.issueId && v.type)
      .filter((v: any) => set.has(String(v.issueId)))
      .map((v: any) => ({ issueId: String(v.issueId), type: v.type as LinkType }));
  }

  /** 共通：ソフトデリート → Undo 5秒 */
  private async softDeleteWithUndo(
    kind: 'problem'|'issue'|'task',
    path: { projectId: string; problemId?: string; issueId?: string; taskId?: string },
    title: string
  ){
    const uid = await firstValueFrom(this.auth.uid$);

    const patch = { softDeleted: true, deletedAt: serverTimestamp(), updatedBy: uid || '' } as any;

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
    title: '',
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

    // ドラフト復元
    const key = this.draftKeyNewProblem();
    if (key) {
      const rec = this.drafts.get<string>(key);
      if (rec) {
        const ok = confirm('未投稿の Problem 作成ドラフトがあります。復元しますか？');
        if (ok) {
          try { this.newProblem = { ...this.newProblem, ...JSON.parse(rec.value || '{}') }; } catch {}
        }
      }
    }
  }
  closeNewProblemDialog() {
    this.newProblemOpen = false;
    this.newProblem = { title: '', phenomenon: '', cause: '', solution: '', goal: '', template: 'bug' };
  }

  // 作成保存
  async createProblemWithDefinition() {
    if (!(await this.requireOnline())) return;

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
        updatedBy: uid || '',
        updatedAt: serverTimestamp(),
      }
    };
    const cause = p.cause.trim();
    const solution = p.solution.trim();
    if (cause) payload.problemDef.cause = cause;
    if (solution) payload.problemDef.solution = solution;

    const ref = await this.problems.create(pid, payload);
    this.selectedProblemId = (ref as any)?.id ?? null;
    this.selectedProblem$.next(this.selectedProblemId);

    const kNew = this.draftKeyNewProblem(); if (kNew) this.drafts.clear(kNew);
    this.closeNewProblemDialog();
  }

  // Firestore Timestamp → Date
  getUpdatedAtDate(p: ProblemWithDef): Date | null {
    const ts: any = p?.problemDef?.updatedAt;
    if (!ts) return null;
    try {
      if (typeof ts.toDate === 'function') return ts.toDate();
      if (ts instanceof Date) return ts;
    } catch {}
    return null;
  }

  // 編集モーダル
  openEditProblemDef(p: ProblemWithDef) {
    this.editProblemOpen = true;
    this.editProblem = {
      title: p.title ?? '',
      phenomenon: p.problemDef?.phenomenon ?? '',
      cause: p.problemDef?.cause ?? '',
      solution: p.problemDef?.solution ?? '',
      goal: p.problemDef?.goal ?? '',
    };

    // 編集ドラフト復元
    const key = this.draftKeyEditProblem(this.selectedProblemId);
    if (key) {
      const rec = this.drafts.get<string>(key);
      if (rec) {
        const ok = confirm('Problem 編集の下書きがあります。復元しますか？');
        if (ok) {
          try { this.editProblem = { ...this.editProblem, ...JSON.parse(rec.value || '{}') }; } catch {}
        }
      }
    }
  }
  closeEditProblemDialog() { this.editProblemOpen = false; }

  // 編集保存
  async saveEditedProblemDef() {
    if (!(await this.requireOnline())) return;

    const pid = this.currentProject.getSync();
    if (!pid || !this.selectedProblemId) { alert('プロジェクト/Problem未選択'); return; }

    const d = this.editProblem;
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
      updatedAt: serverTimestamp(),
    });

    const kEdit = this.draftKeyEditProblem(this.selectedProblemId); if (kEdit) this.drafts.clear(kEdit);
    this.closeEditProblemDialog();
  }

  // 破棄時のタイマー解放 & FCM購読解除
  ngOnDestroy() {
    if (this.issueTitleTimer) { clearTimeout(this.issueTitleTimer); this.issueTitleTimer = null; }
    for (const k of Object.keys(this.taskTitleTimers)) {
      if (this.taskTitleTimers[k]) { clearTimeout(this.taskTitleTimers[k]); this.taskTitleTimers[k] = null; }
    }
    Object.keys(this.newProblemTimers).forEach(k => {
      const kk = k as keyof typeof this.newProblemTimers;
      if (this.newProblemTimers[kk]) clearTimeout(this.newProblemTimers[kk]!);
    });
    Object.keys(this.editProblemTimers).forEach(k => {
      const kk = k as keyof typeof this.editProblemTimers;
      if (this.editProblemTimers[kk]) clearTimeout(this.editProblemTimers[kk]!);
    });

    this.fgSub?.unsubscribe();
  }
}





