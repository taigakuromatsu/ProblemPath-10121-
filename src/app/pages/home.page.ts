import { Component, DestroyRef, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, NgFor, NgIf, JsonPipe, DatePipe, CommonModule } from '@angular/common';
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
import { Observable, BehaviorSubject, of, combineLatest, firstValueFrom } from 'rxjs';
import { switchMap, take, map, startWith, catchError } from 'rxjs/operators';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { serverTimestamp } from 'firebase/firestore';
import { DraftsService } from '../services/drafts.service';
import { NetworkService } from '../services/network.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MessagingService, FcmNotice } from '../services/messaging.service';
import { Firestore } from '@angular/fire/firestore';
import { docData as rxDocData } from 'rxfire/firestore';
import { doc as nativeDoc } from 'firebase/firestore';
import { MatDividerModule } from '@angular/material/divider';
import { AiService } from '../services/ai.service';
import { AiIssueSuggestComponent } from '../components/ai-issue-suggest.component';
import { MatInputModule } from '@angular/material/input';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule, DateAdapter } from '@angular/material/core';
import { FcmTokensService } from '../services/fcm-tokens.service';
import { safeFromProject$ } from '../utils/rx-safe';
import { MatTableModule } from '@angular/material/table';
import { Role, Member } from '../services/members.service';
import { NotifyPrefsService, NotifyPrefs, DueReminderMode } from '../services/notify-prefs.service';

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

type TemplateKind = 'bug' | 'improve' | 'other';
type EditProblemField = 'phenomenon' | 'cause' | 'solution' | 'goal';
type HomeViewHint = 'none' | 'viewer' | 'projectLost';

@Component({
  standalone: true,
  selector: 'pp-home',
  imports: [
    RouterLink, AsyncPipe, NgFor, NgIf, DatePipe, CommonModule, FormsModule,
    MatButtonModule, MatSelectModule, MatFormFieldModule, MatIconModule,
    MatCardModule, MatChipsModule, MatSnackBarModule, TranslateModule,
    MatDividerModule, AiIssueSuggestComponent, MatInputModule, MatDatepickerModule, MatNativeDateModule, MatTableModule
  ],
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss']
})
export class HomePage implements OnInit, OnDestroy {

  readonly NEW_OPTION_VALUE = '__NEW__';

  hint$!: Observable<HomeViewHint>;

  problems$!: Observable<Problem[]>;
  selectedProblemId: string | null = null;

  private selectedProblem$ = new BehaviorSubject<string | null>(null);
  issues$: Observable<Issue[] | null> = of(null);

  // Problem 定義表示用
  selectedProblemDoc$!: Observable<ProblemWithDef | null>;

  issueTitle = '';
  taskTitle: Record<string, string> = {}; // key = issueId
  taskDueDate: Record<string, string> = {};
  taskRecurrenceEnabled: Record<string, boolean> = {};
  taskRecurrenceFreq: Record<string, 'DAILY' | 'WEEKLY' | 'MONTHLY'> = {};
  taskRecurrenceInterval: Record<string, number> = {};
  taskRecurrenceEndDate: Record<string, string> = {};
  tasksMap: Record<string, Observable<Task[]>> = {};

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
  fgMessages$!: Observable<FcmNotice[]>;

  // --- FCM 状態（users/{uid}/fcmStatus/app） ---
  fcmStatus$!: Observable<{ enabled?: boolean; lastTokenSavedAt?: any; lastError?: string } | null>;

  // --- 通知設定 ---
  notifyPrefs$!: Observable<NotifyPrefs | null>;

  // ===== メンバー管理 =====
  membersList$!: Observable<Member[]>;
  adminCount$!: Observable<number>;
  myUid$!: Observable<string | null>;

  // UI一時上書き: uid -> role
  uiRoleOverride: Partial<Record<string, Role>> = {};

  // セレクト用ロール候補（翻訳キーを保持）
  readonly roleOptions: Array<{ value: Role; labelKey: string }> = [
    { value: 'admin',  labelKey: 'role.adminLabel'  },
    { value: 'member', labelKey: 'role.memberLabel' },
    { value: 'viewer', labelKey: 'role.viewerLabel' },
  ];

  // 高速参照用マップ（role -> 翻訳キー）
  private readonly roleLabelMap: Record<Role, string> = {
    admin:  'role.adminLabel',
    member: 'role.memberLabel',
    viewer: 'role.viewerLabel',
  };

  // テンプレから呼ぶ用（純関数）
  getRoleLabelKey(role: Role | null | undefined): string | null {
    return role ? (this.roleLabelMap[role] ?? null) : null;
  }
  
// 追加: 疑似日付入力のモデル（null 可）
dueModel: Record<string, Date | null> = {};
endModel: Record<string, Date | null> = {};

  // 追加: 双方向モデル → 既存の文字列マップへ反映
  onDueModelChange(issueId: string, d: Date | null) {
    this.dueModel[issueId] = d;
    this.taskDueDate[issueId] = d ? this.toYmd(d) : '';
  }
  onEndModelChange(issueId: string, d: Date | null) {
    this.endModel[issueId] = d;
    this.taskRecurrenceEndDate[issueId] = d ? this.toYmd(d) : '';
  }

  // 追加: 明示クリア（ボタン/キー操作用）
  clearDue(issueId: string) {
    this.dueModel[issueId] = null;
    this.taskDueDate[issueId] = '';
  }
  clearEnd(issueId: string) {
    this.endModel[issueId] = null;
    this.taskRecurrenceEndDate[issueId] = '';
  }

  onToggleInstant(key: 'instantComment' | 'instantFile', checked: boolean) {
    this.notifyPrefsService.update({ [key]: checked } as Partial<NotifyPrefs>);
  }

  onChangeDueMode(mode: DueReminderMode) {
    this.notifyPrefsService.update({ dueReminderMode: mode });
  }

  onChangeDueHour(hour: number | string) {
    const n = Number(hour);
    if (!Number.isFinite(n) || n < 0 || n > 23) return;
    this.notifyPrefsService.update({ dueReminderHour: n });
  }


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
    private ai: AiService,
    private dateAdapter: DateAdapter<Date>,
    private fcmTokens: FcmTokensService,
    private notifyPrefsService: NotifyPrefsService
  ) {
    this.isOnline$ = this.network.isOnline$;
    this.canEdit$ = combineLatest([this.members.isEditor$, this.network.isOnline$]).pipe(
      map(([isEditor, online]) => !!isEditor && !!online)
    );

    this.myUid$ = this.auth.uid$;

    // 追加: メンバー一覧とadmin数
    this.membersList$ = this.currentProject.projectId$.pipe(
      switchMap(pid => this.members.list$(pid)),
    );

    // メンバー一覧が更新されたら、上書きマップを掃除（サーバー真実に同化）
    this.membersList$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(list => {
        const set = new Set(list.map(m => m.uid));
        // 消えたUIDの上書きを削除
        for (const k of Object.keys(this.uiRoleOverride)) {
          if (!set.has(k)) delete this.uiRoleOverride[k];
        }
        // サーバー値と一致しているものは上書きを削除（無駄な残りを消す）
        for (const m of list) {
          const cur = this.uiRoleOverride[m.uid];
          if (cur !== undefined && cur === m.role) {
            delete this.uiRoleOverride[m.uid];
          }
        }
      });

    this.adminCount$ = this.membersList$.pipe(
      map(list => list.filter(m => m.role === 'admin').length)
    );

    this.lastAdminUid$ = this.membersList$.pipe(
      map(list => {
        const admins = list.filter(m => m.role === 'admin');
        return admins.length === 1 ? admins[0].uid : null;
      })
    );

    this.notifyPrefs$ = this.notifyPrefsService.prefs$;
  }

  lastAdminUid$!: Observable<string | null>;

  /** 翻訳キーが未登録の時に fallback を返す（テンプレ用） */
  t(key: string, fallback: string): string {
    const v = this.i18n.instant(key);
    return v === key ? fallback : v;
  }

  async onLangChange(next: 'ja' | 'en') {
    this.prefs.update({ lang: next });
    this.i18n.use(next);
    this.dateAdapter.setLocale(next === 'en' ? 'en-US' : 'ja-JP');
    await this.fcmTokens.updateLanguageForAllMyTokens(next);
    await this.fcmTokens.ensureRegistered();
  }

  lang: 'ja' | 'en' = 'ja';
  themeMode: 'light' | 'dark' | 'system' = 'system';

  async ngOnInit() {
    // テーマと言語
    this.prefs.prefs$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(p => {
        this.themeMode = (p?.theme ?? 'system') as any;
        this.lang = (p?.lang === 'en' ? 'en' : 'ja');
        document.documentElement.setAttribute('lang', this.lang === 'en' ? 'en-US' : 'ja-JP');
        this.dateAdapter.setLocale(this.lang === 'en' ? 'en-US' : 'ja-JP');
        this.i18n.use(this.lang);
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
          this.uiRoleOverride = {}; // ログアウトで上書きもクリア
          this.msg.clearAll();
        }
      });

    // Problems（pid 必須）
    this.problems$ = combineLatest([this.auth.loggedIn$, this.currentProject.projectId$]).pipe(
      switchMap(([isIn, pid]) => {
        if (!isIn || !pid || pid === 'default') return of([] as Problem[]);
        return safeFromProject$(
          this.currentProject.projectId$,
          pid => this.problems.list$(pid),
          [] as Problem[]
        );
      })
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
      switchMap(([pidProblem, isIn, pid]) => {
        if (!isIn || !pid || pid === 'default' || !pidProblem) return of([] as Issue[]);
        return safeFromProject$(
          this.currentProject.projectId$,
          pid => this.issues.listByProblem$(pid, pidProblem),
          [] as Issue[]
        );
      })
    );

    // Issue → Task購読 + ドラフト復元
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
          nextMap[id] = this.tasksMap[id] ?? safeFromProject$(
            this.currentProject.projectId$,
            pid => {
              if (!pid || pid === 'default') return of([] as Task[]);
              return this.tasks.listByIssue$(pid, this.selectedProblemId!, id);
            },
            [] as Task[]
          );

          // Task タイトルのドラフト復元
          const keyT = this.draftKeyTaskTitle(this.selectedProblemId, id);
          const recT = keyT ? this.drafts.get<string>(keyT) : null;
          if (recT && !this.taskTitle[id]) {
            this.taskTitle[id] = recT.value || '';
          }
        }
        this.tasksMap = nextMap;
      });

    // --- FCM: 既に権限があればトークン取得＆保存（UI表示はしない） ---
    try {
      this.fcmToken = await this.msg.getTokenIfGranted();
      if (this.fcmToken) {
        await this.fcmTokens.ensureRegistered();
      }
    } catch {}

    // 通知センター一覧（MessagingService 側で集約された直近通知）
    this.fgMessages$ = this.msg.notices$;

    // FCM 状態（users/{uid}/fcmStatus/app はプロジェクト非依存）
    this.fcmStatus$ = this.auth.uid$.pipe(
      switchMap(uid => {
        if (!uid) return of(null);
        const ref = nativeDoc(this.fs as any, `users/${uid}/fcmStatus/app`);
        return rxDocData(ref).pipe(
          map((d: any) => ({ enabled: d?.enabled, lastTokenSavedAt: d?.lastTokenSavedAt, lastError: d?.lastError })),
          switchMap(data => of(data))
        );
      })
    );

    this.hint$ = combineLatest([this.currentProject.projectId$, this.auth.uid$]).pipe(
      switchMap(([pid, uid]) => {
        if (!pid || pid === 'default' || !uid) return of<HomeViewHint>('none');
        const ref = nativeDoc(this.fs as any, `projects/${pid}/members/${uid}`);
        return rxDocData(ref).pipe(
          map((m: any | undefined) => {
            if (!m) return 'projectLost' as HomeViewHint;
            return m.role === 'viewer' ? 'viewer' : 'none';
          }),
          catchError(() => of<HomeViewHint>('projectLost'))
        );
      })
    );
  }

  markAsRead(index: number) {
    this.msg.markAsRead(index);
  }

  clearAllNotices() {
    this.msg.clearAll();
  }

  // ===== メンバー管理：UI一時上書き付きのロール変更 =====
  async onRolePicked(target: Member, next: Role) {
    const prev = target.role;
    const pid = this.currentProject.getSync();
    if (!pid) { alert(this.i18n.instant('common.projectNotSelected')); return; }
    if (!(await this.requireOnline())) return;

    // 最後のadmin保護：発動したらUIも即座に「admin」に固定
    const admins = await firstValueFrom(this.adminCount$);
    if (target.role === 'admin' && next !== 'admin' && admins <= 1) {
      this.uiRoleOverride[target.uid] = 'admin';
      this.snack.open(this.i18n.instant('warn.lastAdminGuard'), undefined, { duration: 3000 });
      return;
    }

    // 自分降格の確認（キャンセル時は元へ）
    const myUid = await firstValueFrom(this.auth.uid$);
    if (target.uid === myUid && next !== 'admin') {
      const ok = confirm(this.i18n.instant('member.confirmDemoteSelf', { role: next }));
      if (!ok) {
        this.uiRoleOverride[target.uid] = prev; // 明示的に巻き戻す
        return;
      }
    }

    // 楽観的UI
    this.uiRoleOverride[target.uid] = next;

    try {
      await this.members.updateRole(pid, target.uid, next);
      // サーバーのpushで正が流れてくるので上書きは消す
      delete this.uiRoleOverride[target.uid];
      this.snack.open(this.i18n.instant('member.roleUpdated'), undefined, { duration: 2000 });
    } catch (e) {
      // 失敗（permission-denied等）はUIを元へ
      this.uiRoleOverride[target.uid] = prev;
      console.error(e);
      this.snack.open(this.i18n.instant('error.failed'), undefined, { duration: 2500 });
    }
  }

  /** 互換: 既存テンプレ呼び出しがある場合に備えて委譲 */
  async changeMemberRole(target: Member, next: Role) {
    return this.onRolePicked(target, next);
  }

  // ===== メンバー管理：削除 =====
  async removeMember(target: Member) {
    if (!(await this.requireOnline())) return;
    const pid = this.currentProject.getSync();
    if (!pid) { alert(this.i18n.instant('common.projectNotSelected')); return; }

    const admins = await firstValueFrom(this.adminCount$);
    if (target.role === 'admin' && admins <= 1) {
      this.snack.open(this.i18n.instant('warn.lastAdminGuard'), undefined, { duration: 3000 });
      return;
    }

    const ok = confirm(this.i18n.instant('member.confirmRemove', { name: target.displayName || target.email || target.uid }));
    if (!ok) return;

    try {
      await this.members.removeMembership(pid, target.uid);
      // サーバーが正なので上書きは不要だが一応掃除
      delete this.uiRoleOverride[target.uid];
      this.snack.open(this.i18n.instant('member.removed'), undefined, { duration: 2000 });
    } catch (e) {
      console.error(e);
      this.snack.open(this.i18n.instant('error.failed'), undefined, { duration: 2500 });
    }
  }

  // HomePage クラス内のどこかに追加
  toDate(s?: string | null): Date | null {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  toYmd(d?: Date | null): string {
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  onDuePicked(issueId: string, date: Date | null) {
    this.taskDueDate[issueId] = date ? this.toYmd(date) : '';
  }
  onRecurEndPicked(issueId: string, date: Date | null) {
    this.taskRecurrenceEndDate[issueId] = date ? this.toYmd(date) : '';
  }

  // 通知の権限リクエスト → トークン取得 → Firestore 保存
  async askNotificationPermission() {
    try {
      const t = await this.msg.requestPermissionAndGetToken();
      this.fcmToken = t; // UIは出さないが状態保持のみ
      await this.fcmTokens.ensureRegistered();
      this.snack.open(this.i18n.instant('home.notifications.enabledSnack'), undefined, { duration: 2000 });
    } catch (e: any) {
      console.error('[FCM] permission/token error', e);
      this.snack.open(this.i18n.instant('home.notifications.failedSnack'), undefined, { duration: 2500 });
    }
  }

  async switchAccount() {
    await this.auth.signOut();
    await this.auth.signInWithGoogle({ forceChoose: true });
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
    if (!pid) { alert(this.i18n.instant('common.projectNotSelected')); return; }
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
        const ok = confirm(this.i18n.instant('draft.restoreIssueTitle'));
        if (ok) this.issueTitle = rec.value || '';
      }
    }
  }

  // 共通 withPid
  private withPid(run: (pid: string) => void) {
    this.currentProject.projectId$.pipe(take(1)).subscribe(pid => {
      if (!pid || pid === 'default') {
        alert(this.i18n.instant('common.projectNotSelected'));
        return;
      }
      run(pid);
    });
  }

  // オンライン必須ガード
  private async requireOnline(): Promise<boolean> {
    const online = await firstValueFrom(this.isOnline$);
    if (!online) {
      alert(this.i18n.instant('error.offlineActionBlocked'));
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
    const input = prompt(this.i18n.instant('tree.prompt.renameProblem'));
    if (!input?.trim()) return;
  
    const t = input.trim();
    if (t.length > 200) {
      alert(this.t('validation.max.problemTitle', '問題タイトルは200文字以内で入力してください'));
      return;
    }
  
    this.withPid(pid => this.problems.update(pid, this.selectedProblemId!, { title: t }));
  }

  async removeSelected() {
    if (!this.selectedProblemId) return;
    if (!(await this.requireOnline())) return;
    if (!confirm(this.i18n.instant('home.confirm.deleteProblemAndChildren'))) return;
  
    const problemId = this.selectedProblemId!;
    const problemDoc = await firstValueFrom(this.selectedProblemDoc$);
    const problemTitle = problemDoc?.title || '(Problem)';
  
    // 先に UI 側をクリアしておく（MatSelect から消す）
    this.selectedProblemId = null;
    this.selectedProblem$.next(null);
  
    this.withPid(async pid => {
      await this.softDeleteWithUndo('problem', { projectId: pid, problemId }, problemTitle);
    });
  }

  // --- Issue 操作 ---
  async createIssue(problemId: string) {
    if (!(await this.requireOnline())) return;
    const t = this.issueTitle.trim();
    if (!t) return;
  
    if (t.length > 100) {
      alert(this.t('validation.max.issueTitle', '課題タイトルは100文字以内で入力してください'));
      return;
    }
  
    this.withPid(pid => this.issues.create(pid, problemId, { title: t }).then(() => {
      this.issueTitle = '';
      const key = this.draftKeyIssueTitle(this.selectedProblemId);
      if (key) this.drafts.clear(key);
    }));
  }
  

  async renameIssue(problemId: string, i: Issue) {
    if (!(await this.requireOnline())) return;
    const input = prompt(this.i18n.instant('tree.prompt.renameIssue'), i.title);
    if (!input?.trim()) return;
  
    const t = input.trim();
    if (t.length > 100) {
      alert(this.t('validation.max.issueTitle', '課題タイトルは100文字以内で入力してください'));
      return;
    }
  
    this.withPid(pid => this.issues.update(pid, problemId, i.id!, { title: t }));
  }
  

  async removeIssue(problemId: string, i: Issue) {
    if (!(await this.requireOnline())) return;
    if (!confirm(this.i18n.instant('tree.confirm.deleteIssue', { name: i.title }))) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('issue', { projectId: pid, problemId, issueId: i.id! }, i.title);
    });
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
  
    if (t.length > 80) {
      alert(this.t('validation.max.taskTitle', 'タスクタイトルは80文字以内で入力してください'));
      return;
    }
    const dueRaw = (this.taskDueDate[issueId] ?? '').trim();
    if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) {
      alert(this.t('recurrence.invalidDate', '日付は YYYY-MM-DD 形式で入力してください'));
      return;
    }

    const recurrenceEnabled = !!this.taskRecurrenceEnabled[issueId];
    const freq = this.taskRecurrenceFreq[issueId] ?? 'WEEKLY';
    let interval = Number(this.taskRecurrenceInterval[issueId] ?? 1);
    if (!Number.isFinite(interval) || interval < 1) interval = 1;
    const endRaw = (this.taskRecurrenceEndDate[issueId] ?? '').trim();
    if (recurrenceEnabled && endRaw && !/^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
      alert(this.t('recurrence.invalidDate', '日付は YYYY-MM-DD 形式で入力してください'));
      return;
    }
    if (recurrenceEnabled && dueRaw && endRaw && endRaw < dueRaw) {
      alert(this.t('recurrence.endAfterStart', '終了日は開始日（初回期日）以降を指定してください'));
      return;
    }

    if (recurrenceEnabled && !dueRaw) {
      alert(this.t('recurrence.anchorRequired', '繰り返しを設定するには初回期日が必要です'));
      return;
    }

    const payload: Partial<Task> = {
      title: t,
      dueDate: dueRaw ? dueRaw : null,
    };

    if (recurrenceEnabled && dueRaw) {
      payload.recurrenceRule = { freq, interval };
      payload.recurrenceAnchorDate = dueRaw;
      if (endRaw) payload.recurrenceEndDate = endRaw;
    }

    this.withPid(async pid => {
      await this.tasks.create(pid, problemId, issueId, payload);
      if (recurrenceEnabled && dueRaw) {
        await this.tasks.create(pid, problemId, issueId, { title: t, dueDate: dueRaw });
      }
      this.taskTitle[issueId] = '';
      this.taskDueDate[issueId] = '';
      this.taskRecurrenceEnabled[issueId] = false;
      this.taskRecurrenceInterval[issueId] = 1;
      this.taskRecurrenceFreq[issueId] = freq;
      this.taskRecurrenceEndDate[issueId] = '';
      const key = this.draftKeyTaskTitle(this.selectedProblemId, issueId);
      if (key) this.drafts.clear(key);
    });
  }

  onRecurrenceToggle(issueId: string, enabled: boolean) {
    this.taskRecurrenceEnabled[issueId] = enabled;
    if (enabled) {
      if (!this.taskRecurrenceInterval[issueId]) this.taskRecurrenceInterval[issueId] = 1;
      if (!this.taskRecurrenceFreq[issueId]) this.taskRecurrenceFreq[issueId] = 'WEEKLY';
    }
  }

  async renameTask(problemId: string, issueId: string, task: Task) {
    if (!(await this.requireOnline())) return;
    const input = prompt(this.i18n.instant('tree.prompt.renameTask'), task.title);
    if (!input?.trim()) return;
  
    const t = input.trim();
    if (t.length > 80) {
      alert(this.t('validation.max.taskTitle', 'タスクタイトルは80文字以内で入力してください'));
      return;
    }
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, task.id!, { title: t }));
  }

  async removeTask(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
    if (t.recurrenceTemplate) {
      alert(this.t('recurrence.stopHint', '繰り返しテンプレートは停止後に削除できます'));
      return;
    }
    if (!confirm(this.i18n.instant('tree.confirm.deleteTask', { name: t.title }))) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('task', { projectId: pid, problemId, issueId, taskId: t.id! }, t.title);
    });
  }

  // 期日・タグ編集
  async editTaskDue(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
    if (t.recurrenceTemplate) {
      alert(this.t('recurrence.dueDisabled', '繰り返しテンプレートの期限は自動で管理されます'));
      return;
    }
    const cur = t.dueDate ?? '';
    const nxt = prompt(this.i18n.instant('task.promptDue'), cur ?? '');
    if (nxt === null) return;
    const dueDate = (nxt.trim() === '') ? null : nxt.trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      alert(this.t('recurrence.invalidDate', '日付は YYYY-MM-DD 形式で入力してください'));
      return;
    }
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, t.id!, { dueDate }));
  }

  async editTaskTags(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
    if (t.recurrenceTemplate) {
      alert(this.t('recurrence.tagDisabled', '繰り返しテンプレートは将来のタスク作成時にコピーされます'));
      return;
    }
    const current = (t.tags ?? []).join(', ');
    const input = prompt(this.i18n.instant('task.promptTags'), current ?? '');
    if (input == null) return;
  
    const tags = input
      .split(/[, \s]+/)
      .map(s => s.replace(/^#/, '').trim())
      .filter(Boolean);
  
    // ★ タグ名 1〜15文字制限
    for (const tag of tags) {
      if (tag.length > 15) {
        alert(this.t('validation.max.tag', 'タグは1つ15文字以内で入力してください'));
        return;
      }
    }
  
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, t.id!, { tags }));
  }
  

  // 繰り返し停止（テンプレ削除）
  async stopRecurrence(problemId: string, issueId: string, task: Task) {
    if (!(await this.requireOnline())) return;
    if (!task?.id) return;

    const ok = confirm(this.t(
      'recurrence.stopAndDeleteConfirm',
      '繰り返しを停止し、テンプレートを削除します。既存のタスクは残ります。'
    ));
    if (!ok) return;

    this.withPid(async pid => {
      await this.softDeleteWithUndo(
        'task',
        { projectId: pid, problemId, issueId, taskId: task.id! },
        task.title || '(template)'
      );
    });
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

  /** 共通：ソフトデリート → Undo 5秒（トースト文言i18n） */
  private async softDeleteWithUndo(
    kind: 'problem' | 'issue' | 'task',
    path: { projectId: string; problemId?: string; issueId?: string; taskId?: string },
    title: string
  ) {
    const uid = await firstValueFrom(this.auth.uid$);
    const patch = {
      softDeleted: true,
      deletedAt: serverTimestamp(),
      updatedBy: uid || '',
    } as any;
  
    // --- 本体 + 子タスクの softDelete ---
    if (kind === 'problem') {
      // Problem 本体を softDelete
      await this.problems.update(path.projectId, path.problemId!, patch);
      // 配下 Task も softDelete（Issue は既存一覧側で softDeleted を見る前提なら任意）
      await this.tasks.markByProblemSoftDeleted(path.projectId, path.problemId!, true);
    } else if (kind === 'issue') {
      await this.issues.update(path.projectId, path.problemId!, path.issueId!, patch);
      await this.tasks.markByIssueSoftDeleted(path.projectId, path.problemId!, path.issueId!, true);
    } else {
      await this.tasks.update(path.projectId, path.problemId!, path.issueId!, path.taskId!, patch);
    }
  
    // --- Undo スナックバー ---
    const ref = this.snack.open(
      this.i18n.instant('toast.deleted', { name: title }),
      this.i18n.instant('common.undo'),
      { duration: 5000 }
    );
  
    ref.onAction().subscribe(async () => {
      const unpatch = {
        softDeleted: false,
        deletedAt: null,
        updatedBy: uid || '',
      } as any;
  
      if (kind === 'problem') {
        await this.problems.update(path.projectId, path.problemId!, unpatch);
        await this.tasks.markByProblemSoftDeleted(path.projectId, path.problemId!, false);
      } else if (kind === 'issue') {
        await this.issues.update(path.projectId, path.problemId!, path.issueId!, unpatch);
        await this.tasks.markByIssueSoftDeleted(path.projectId, path.problemId!, path.issueId!, false);
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
    template: 'bug' as TemplateKind,
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

  applyProblemTemplate(kind: TemplateKind) {
    this.newProblem.template = kind;
  }

  openNewProblemDialog() {
    this.newProblemOpen = true;
    this.applyProblemTemplate(this.newProblem.template);

    // ドラフト復元
    const key = this.draftKeyNewProblem();
    if (key) {
      const rec = this.drafts.get<string>(key);
      if (rec) {
        const ok = confirm(this.i18n.instant('draft.restoreNewProblem'));
        if (ok) {
          try { this.newProblem = { ...this.newProblem, ...JSON.parse(rec.value || '{}') }; } catch {}
        }
      }
    }
  }
  closeNewProblemDialog() {
    this.newProblemOpen = false;
    this.newProblem = { title: '', phenomenon: '', cause: '', solution: '', goal: '', template: 'bug' as TemplateKind };
  }

  // 作成保存（バリデーション文言 i18n）
  async createProblemWithDefinition() {
    if (!(await this.requireOnline())) return;

    const p = this.newProblem;
    const errs: string[] = [];
    if (!p.title.trim()) errs.push(this.i18n.instant('validation.titleRequired'));
    if (!p.phenomenon.trim()) errs.push(this.i18n.instant('validation.phenomenonRequired'));
    if (!p.goal.trim()) errs.push(this.i18n.instant('validation.goalRequired'));
    const over = (s: string, n: number) => s && s.length > n;
    if (over(p.title, 200)) errs.push(this.t('validation.max.problemTitle', '問題タイトルは200文字以内で入力してください'));
    if (over(p.phenomenon, 500)) errs.push(this.t('validation.max.phenomenon', '現象は500文字以内で入力してください'));
    if (over(p.cause, 500)) errs.push(this.t('validation.max.cause', '原因は500文字以内で入力してください'));
    if (over(p.solution, 500)) errs.push(this.t('validation.max.solution', '解決策は500文字以内で入力してください'));
    if (over(p.goal, 300)) errs.push(this.t('validation.max.goal', '目標は300文字以内で入力してください'));
  
    if (errs.length) { alert(errs.join('\n')); return; }

    const pid = this.currentProject.getSync();
    if (!pid) { alert(this.i18n.instant('common.projectNotSelected')); return; }

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
        const ok = confirm(this.i18n.instant('draft.restoreEditProblem'));
        if (ok) {
          try { this.editProblem = { ...this.editProblem, ...JSON.parse(rec.value || '{}') }; } catch {}
        }
      }
    }
  }
  closeEditProblemDialog() { this.editProblemOpen = false; }

  // 編集保存（バリデーション文言 i18n）
  async saveEditedProblemDef() {
    if (!(await this.requireOnline())) return;

    const pid = this.currentProject.getSync();
    if (!pid || !this.selectedProblemId) { alert(this.i18n.instant('common.projectNotSelected')); return; }

    const d = this.editProblem;
    const errs: string[] = [];
    if (!d.phenomenon.trim()) errs.push(this.i18n.instant('validation.phenomenonRequired'));
    if (!d.goal.trim()) errs.push(this.i18n.instant('validation.goalRequired'));
    const over = (s: string, n: number) => s && s.length > n;
    if (over(d.phenomenon, 500)) errs.push(this.t('validation.max.phenomenon', '現象は500文字以内で入力してください'));
    if (over(d.cause, 500)) errs.push(this.t('validation.max.cause', '原因は500文字以内で入力してください'));
    if (over(d.solution, 500)) errs.push(this.t('validation.max.solution', '解決策は500文字以内で入力してください'));
    if (over(d.goal, 300)) errs.push(this.t('validation.max.goal', '目標は300文字以内で入力してください'));
  
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

  }


  getProblemPlaceholder(
    field: 'title' | 'phenomenon' | 'cause' | 'solution' | 'goal'
  ): string {
    const kind = this.newProblem.template;
  
    // === タイトル ===
    if (field === 'title') {
      if (kind === 'bug') {
        return this.t(
          'home.problemTemplate.bug.titlePlaceholder',
          '（例）申請フォーム送信完了メッセージが表示されない'
        );
      }
      if (kind === 'improve') {
        return this.t(
          'home.problemTemplate.improve.titlePlaceholder',
          '（例）週次レポート作業に時間がかかりすぎている'
        );
      }
      // other
      return this.t(
        'home.problemTemplate.other.titlePlaceholder',
        '（例）対応ルールが部署ごとにバラバラで統一されていない'
      );
    }
  
    // === 現象 ===
    if (kind === 'bug' && field === 'phenomenon') {
      return this.t(
        'home.problemTemplate.bug.phenomenonPlaceholder',
        '（例）申請フォームの送信ボタンを押しても完了メッセージが出ず、送信できたか分からない'
      );
    }
    if (kind === 'improve' && field === 'phenomenon') {
      return this.t(
        'home.problemTemplate.improve.phenomenonPlaceholder',
        '（例）週次レポート作成に毎回2〜3時間かかり、本来の業務に手が回っていない'
      );
    }
    if (kind === 'other' && field === 'phenomenon') {
      return this.t(
        'home.problemTemplate.other.phenomenonPlaceholder',
        '（例）担当者ごとに対応ルールが違い、お客様への説明内容がバラバラになっている'
      );
    }
  
    // === 目標 ===
    if (kind === 'bug' && field === 'goal') {
      return this.t(
        'home.problemTemplate.bug.goalPlaceholder',
        '（例）送信後3秒以内に「送信完了」が表示され、利用者が不安にならない状態にする'
      );
    }
    if (kind === 'improve' && field === 'goal') {
      return this.t(
        'home.problemTemplate.improve.goalPlaceholder',
        '（例）レポート作成時間を30分以内に短縮し、担当者の残業を減らす'
      );
    }
    if (kind === 'other' && field === 'goal') {
      return this.t(
        'home.problemTemplate.other.goalPlaceholder',
        '（例）共通ルールを文書化し、誰が対応しても同じ説明ができる状態にする'
      );
    }
  
    // === 共通（原因・対策案）===
    if (field === 'cause') {
      return this.t(
        'home.problemTemplate.common.causePlaceholder',
        '（任意）発生条件や原因の仮説など'
      );
    }
    if (field === 'solution') {
      return this.t(
        'home.problemTemplate.common.solutionPlaceholder',
        '（任意）検討中の対策案があれば記載'
      );
    }
  
    return '';
  }

}







