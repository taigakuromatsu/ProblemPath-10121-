// src/app/pages/board.page.ts
import { Component, DestroyRef } from '@angular/core';
import { AsyncPipe, DatePipe, NgFor, NgIf, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable, BehaviorSubject, of, combineLatest, firstValueFrom } from 'rxjs';
import { switchMap, shareReplay, take, tap, map, distinctUntilChanged } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { Problem, Issue, Task, BoardColumn, DEFAULT_BOARD_COLUMNS } from '../models/types';
import { BoardColumnsService } from '../services/board-columns.service';
import { BoardColumnEditDialogComponent, BoardColumnEditDialogResult } from '../components/board-column-edit-dialog.component';

import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem, CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import { Router, ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../services/auth.service';
import { MembersService } from '../services/members.service';
import { NetworkService } from '../services/network.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

// メンバー名解決用（スケジュールと同等）
import { Firestore } from '@angular/fire/firestore';
import { collection, query as nativeQuery } from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';
import { safeFromProject$ } from '../utils/rx-safe';

type MemberOption = { uid: string; label: string };

@Component({
  standalone: true,
  selector: 'pp-board',
  imports: [
    AsyncPipe, NgFor, NgIf, NgClass, DatePipe,
    FormsModule,
    MatButtonModule, MatIconModule, MatFormFieldModule, MatSelectModule, MatCardModule, MatChipsModule,
    DragDropModule, MatSnackBarModule, TranslateModule, MatDialogModule,
    MatMenuModule,
    MatTooltipModule,
  ],
  templateUrl: './board.page.html',
  styleUrls: ['./board.page.scss']
})
export class BoardPage {
  columns: BoardColumn[] = DEFAULT_BOARD_COLUMNS;

  /** 繰り返しテンプレートでない実体タスクだけ通す */
  private isRealTask(t: Task | null | undefined): t is Task {
    return !!t && (t as any).recurrenceTemplate !== true;
  }

  readonly categoryAccent: Record<BoardColumn['categoryHint'], string> = {
    not_started: '#9ca3af',
    in_progress: '#0ea5e9',
    done: '#22c55e'
  };

  problems$!: Observable<Problem[]>;
  selectedProblemId: string | null = null;

  private selectedProblem$ = new BehaviorSubject<string | null>(null);
  issues$: Observable<Issue[] | null> = of(null);

  private columnTotals = new Map<string, number>();
  totalFor(columnId: string): number {
    return this.columnTotals.get(columnId) ?? 0;
  }

  // 権限/オンライン
  isEditor$!: Observable<boolean>;
  isOnline$!: Observable<boolean>;
  canEdit$!: Observable<boolean>;
  isAdmin$!: Observable<boolean>;

  // busy
  busyTaskIds = new Set<string>();
  isBusy(id: string | undefined | null): boolean { return !!id && this.busyTaskIds.has(id); }

  // タスク購読
  tasksMap: Record<string, Observable<Task[]>> = {};
  private taskCountSubs = new Map<string, import('rxjs').Subscription>();
  private tasksSnapshot: Record<string, Task[]> = {};

  // ツールチップ用メンバーディレクトリ
  memberOptions$!: Observable<MemberOption[]>;
  memberDirectory$!: Observable<Record<string, string>>;

  constructor(
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    private router: Router,
    private route: ActivatedRoute,
    private destroyRef: DestroyRef,
    public auth: AuthService,
    private currentProject: CurrentProjectService,
    private boardColumns: BoardColumnsService,
    public members: MembersService,
    private network: NetworkService,
    private snack: MatSnackBar,
    private tr: TranslateService,
    private dialog: MatDialog,
    private fs: Firestore,
  ) {
    this.isEditor$ = this.members.isEditor$;
    this.isOnline$ = this.network.isOnline$;
    this.isAdmin$ = this.members.isAdmin$;
    this.canEdit$ = combineLatest([this.members.isEditor$, this.network.isOnline$]).pipe(
      map(([isEditor, online]) => !!isEditor && !!online)
    );
  }

  columnTitle(column: BoardColumn): string {
    const trimmed = (column.title ?? '').trim();
    if (trimmed) {
      return trimmed;
    }
    return this.tr.instant(`board.col.${column.columnId}`);
  }

  columnTitleByCategory(category: BoardColumn['categoryHint']): string {
    const columnId = this.resolveColumnIdForCategory(category);
    const column = this.columnById(columnId);
    if (column) {
      return this.columnTitle(column);
    }
    return this.tr.instant(`board.col.${category}`);
  }

  async onEditColumn(column: BoardColumn) {
    const ref = this.dialog.open(BoardColumnEditDialogComponent, {
      width: '420px',
      data: { column },
    });
    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;

    const patch: BoardColumnEditDialogResult = {
      title: result.title,
      categoryHint: result.categoryHint,
      progressHint: Math.min(100, Math.max(0, Number(result.progressHint ?? 0))),
    };

    this.withPid(async (pid) => {
      try {
        await this.boardColumns.updateColumn(pid, column.columnId, patch);
        this.snack.open(this.tr.instant('board.toast.saved'), this.tr.instant('common.ok'), { duration: 2500 });
      } catch (err) {
        console.error('[BoardPage] Failed to update column', err);
        this.snack.open(this.tr.instant('board.err.update'), this.tr.instant('common.ok'), { duration: 3000 });
      }
    });
  }

  async onAddColumn() {
    if (!(await this.requireCanEdit())) return;

    const dialogColumn: BoardColumn = {
      columnId: 'new',
      title: '',
      order: this.nextColumnOrder(),
      categoryHint: 'in_progress',
      progressHint: 50,
    };

    const ref = this.dialog.open(BoardColumnEditDialogComponent, {
      width: '420px',
      data: { column: dialogColumn },
    });

    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return;

    const nextOrder = this.nextColumnOrder();

    this.withPid(async (pid) => {
      try {
        const columnId = `col_${Date.now()}`;
        await this.boardColumns.createColumn(pid, {
          columnId,
          title: result.title,
          order: nextOrder,
          categoryHint: result.categoryHint,
          progressHint: Math.min(100, Math.max(0, Number(result.progressHint ?? 0))),
        });
        this.snack.open(this.tr.instant('board.toast.columnAdded'), this.tr.instant('common.ok'), { duration: 2500 });
      } catch (err) {
        console.error('[BoardPage] Failed to create column', err);
        this.snack.open(this.tr.instant('board.err.columnAdd'), this.tr.instant('common.ok'), { duration: 3000 });
      }
    });
  }

  async onDeleteColumn(column: BoardColumn) {
    if (!(await this.requireCanEdit())) return;
    if (!column?.columnId) return;

    const ok = confirm(this.tr.instant('board.confirm.deleteColumn', { name: this.columnTitle(column) }));
    if (!ok) return;

    this.withPid(async (pid) => {
      try {
        await this.boardColumns.deleteColumn(pid, column.columnId);
        this.snack.open(this.tr.instant('board.toast.columnDeleted'), this.tr.instant('common.ok'), { duration: 2500 });
      } catch (err) {
        console.error('[BoardPage] Failed to delete column', err);
        this.snack.open(this.tr.instant('board.err.columnDelete'), this.tr.instant('common.ok'), { duration: 3000 });
      }
    });
  }

  async onColumnDrop(event: CdkDragDrop<BoardColumn[]>) {
    if (!(await this.requireCanEdit())) return;
    if (event.previousIndex === event.currentIndex) return;

    const reordered = [...this.columns];
    moveItemInArray(reordered, event.previousIndex, event.currentIndex);

    const withOrder = this.reindexColumns(reordered);
    this.columns = withOrder;
    this.resetColumnTotals();
    this.recalcTotals();

    this.withPid(async (pid) => {
      try {
        await Promise.all(
          withOrder.map((col) =>
            this.boardColumns.updateColumn(pid, col.columnId, { order: col.order })
          )
        );
      } catch (err) {
        console.error('[BoardPage] Failed to reorder columns', err);
        this.snack.open(this.tr.instant('board.err.orderSave'), this.tr.instant('common.ok'), { duration: 3000 });
      }
    });
  }

  allowDnD = false;

  ngOnInit() {
    // プロジェクト/問題
    this.problems$ = safeFromProject$(
      this.currentProject.projectId$,
      pid => this.problems.list$(pid),
      [] as Problem[]
    );

    // 列の購読
    safeFromProject$(
      this.currentProject.projectId$,
      pid => this.boardColumns.list$(pid),
      DEFAULT_BOARD_COLUMNS
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(cols => {
        console.log('[BoardPage] received columns =', cols);
        this.currentProject.projectId$.pipe(take(1)).subscribe(latestPid => {
          console.log('[BoardPage] latestPid =', latestPid);
        });
        this.columns = cols;
        this.resetColumnTotals();
        this.recalcTotals();
      });

    this.canEdit$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(v => this.allowDnD = !!v);

    // Issue → Task ストリーム
    this.issues$ = this.selectedProblem$.pipe(
      distinctUntilChanged(),
      switchMap(problemId => {
        if (!problemId) return of([] as Issue[]);
        return safeFromProject$(
          this.currentProject.projectId$,
          pid => this.issues.listByProblem$(pid, problemId).pipe(
            tap(list => this.setupTaskStreams(problemId, list))
          ),
          [] as Issue[]
        );
      })
    );

    // URLパラメータ
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(m => {
        const pid = m.get('pid');
        this.selectedProblemId = pid;
        this.selectedProblem$.next(pid);
      });

    // ▼ 担当者名ディレクトリ
    this.memberOptions$ = safeFromProject$(
      this.currentProject.projectId$,
      pid => {
        const col = collection(this.fs as any, `projects/${pid}/members`);
        const q = nativeQuery(col);
        return (rxCollectionData(q, { idField: 'id' }) as Observable<any[]>).pipe(
          map(docs => docs.map((docSnap: any) => {
            const data: any = docSnap;
            return {
              uid: docSnap.id || '',
              label: data?.displayName || data?.email || docSnap.id || '',
            } as MemberOption;
          }))
        );
      },
      [] as MemberOption[]
    );

    this.memberDirectory$ = this.memberOptions$.pipe(
      map(list => {
        const dir: Record<string, string> = {};
        for (const m of list) dir[m.uid] = m.label;
        return dir;
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  onSelectProblem(problemId: string | null) {
    this.taskCountSubs.forEach(s => s.unsubscribe());
    this.taskCountSubs.clear();
    this.tasksSnapshot = {};
    this.resetColumnTotals();
    this.tasksMap = {};

    this.selectedProblemId = problemId;
    this.selectedProblem$.next(problemId);
    this.router.navigate([], { queryParams: { pid: problemId }, queryParamsHandling: 'merge' });
  }

  private setupTaskStreams(problemId: string | null, issues: Issue[]) {
    const aliveKeys = new Set((issues ?? []).map(i => this.key(problemId!, i.id!)));
    for (const [k, sub] of this.taskCountSubs.entries()) {
      if (!aliveKeys.has(k)) {
        sub.unsubscribe();
        this.taskCountSubs.delete(k);
        delete this.tasksSnapshot[k];
      }
    }

    if (!problemId) return;
    for (const i of issues ?? []) {
      const k = this.key(problemId, i.id!);
      if (!this.tasksMap[k]) {
        this.tasksMap[k] = safeFromProject$(
          this.currentProject.projectId$,
          pid => this.tasks.listByIssue$(pid, problemId, i.id!),
          [] as Task[]
        ).pipe(
          map(rows => (rows ?? []).filter(t => this.isRealTask(t))),
          shareReplay(1)
        );
      }
      if (!this.taskCountSubs.has(k)) {
        const sub = this.tasksMap[k].subscribe(ts => {
          this.tasksSnapshot[k] = ts ?? [];
          this.recalcTotals();
        });
        this.taskCountSubs.set(k, sub);
      }
    }

    this.recalcTotals();
  }

  private recalcTotals() {
    const totals = new Map<string, number>();
    for (const column of this.columns) {
      totals.set(column.columnId, 0);
    }
    for (const list of Object.values(this.tasksSnapshot)) {
      for (const x of list) {
        const columnId = this.columnIdForTask(x);
        totals.set(columnId, (totals.get(columnId) ?? 0) + 1);
      }
    }
    this.columnTotals = totals;
  }

  async setTaskStatus(
    problemId: string,
    issueId: string,
    t: Task,
    columnId: string
  ) {
    if (!(await this.requireCanEdit())) return;
    if (!t.id || this.isBusy(t.id)) return;
    const status = this.statusForColumn(columnId);
    const progress = this.progressForColumn(columnId);

    const prevStatus = t.status;
    const prevProgress = t.progress;
    const prevColumnId = t.boardColumnId;

    t.status = status;
    t.progress = progress;
    t.boardColumnId = columnId;
    this.recalcTotals();

    this.busyTaskIds.add(t.id);
    this.withPid(async pid => {
      try {
        await this.tasks.update(pid, problemId, issueId, t.id!, {
          status,
          progress,
          boardColumnId: columnId,
        });
      }
      catch (e) {
        console.error(e);
        t.status = prevStatus;
        t.progress = prevProgress;
        t.boardColumnId = prevColumnId;
        this.recalcTotals();
        this.snack.open(this.tr.instant('board.err.update'), this.tr.instant('common.ok'), { duration: 3000 });
      }
      finally { this.busyTaskIds.delete(t.id!); }
    });
  }

  async onListDrop(ev: CdkDragDrop<Task[]>, problemId: string, issueId: string) {
    if (!(await this.requireCanEdit())) return;

    const destColumnId = this.columnIdFromListId(ev.container.id);
    const destStatus = this.statusForColumn(destColumnId);

    const src = ev.previousContainer.data ?? [];
    const dst = ev.container.data ?? [];

    if (ev.previousContainer === ev.container) {
      moveItemInArray(dst, ev.previousIndex, ev.currentIndex);
      await this.persistOrder(problemId, issueId, dst);
      return;
    }

    transferArrayItem(src, dst, ev.previousIndex, ev.currentIndex);

    const moved = dst[ev.currentIndex];
    if (!moved?.id || this.isBusy(moved.id)) return;

    const id = moved.id!;
    const progress = this.progressForColumn(destColumnId);

    const prevStatus = moved.status;
    const prevProgress = moved.progress;
    const prevColumnId = moved.boardColumnId;

    moved.status = destStatus;
    moved.progress = progress;
    moved.boardColumnId = destColumnId;
    this.recalcTotals();

    this.busyTaskIds.add(moved.id);
    this.withPid(async pid => {
      try {
        await this.tasks.update(pid, problemId, issueId, id, {
          status: destStatus,
          progress,
          boardColumnId: destColumnId,
        });
      }
      catch (e) {
        console.error(e);
        moved.status = prevStatus;
        moved.progress = prevProgress;
        moved.boardColumnId = prevColumnId;
        this.recalcTotals();
        this.snack.open(this.tr.instant('board.err.statusUpdate'), this.tr.instant('common.ok'), { duration: 3000 });
      }
      finally { this.busyTaskIds.delete(id); }
    });

    await Promise.all([
      this.persistOrder(problemId, issueId, src),
      this.persistOrder(problemId, issueId, dst),
    ]);
  }

  private async persistOrder(problemId: string, issueId: string, arr: Task[]) {
    if (!(await this.requireCanEdit())) return;
    const updates = arr.map((t, idx) => ({ id: t.id!, order: (idx + 1) * 10 }));
    this.withPid(async pid => {
      for (const u of updates) {
        if (!u.id || this.isBusy(u.id)) continue;
        this.busyTaskIds.add(u.id);
        try { await this.tasks.update(pid, problemId, issueId, u.id, { order: u.order }); }
        catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.orderSave'), this.tr.instant('common.ok'), { duration: 3000 }); }
        finally { this.busyTaskIds.delete(u.id); }
      }
    });
  }

  // 優先度更新
  async setTaskPriority(
    problemId: string,
    issueId: string,
    t: Task,
    newPriority: 'low' | 'mid' | 'high'
  ) {
    if (!(await this.requireCanEdit())) return;
    if (!t.id || this.isBusy(t.id)) return;

    const prevPriority = t.priority;
    t.priority = newPriority;

    this.busyTaskIds.add(t.id);
    this.withPid(async pid => {
      try {
        await this.tasks.update(pid, problemId, issueId, t.id!, {
          priority: newPriority,
        });
      } catch (e) {
        console.error(e);
        t.priority = prevPriority;
        this.snack.open(this.tr.instant('board.err.update'), this.tr.instant('common.ok'), { duration: 3000 });
      } finally {
        this.busyTaskIds.delete(t.id!);
      }
    });
  }

  trackTask = (_: number, t: Task) => t.id;
  key(problemId: string, issueId: string) { return `${problemId}_${issueId}`; }

  listIds(issueId: string): string[] {
    return this.columns.map(col => this.listId(col, issueId));
  }
  listId(column: BoardColumn, issueId: string): string {
    return `dl-${column.columnId}__${issueId}`;
  }

  private columnIdFromListId(listId: string): string {
    const prefix = 'dl-';
    if (!listId.startsWith(prefix)) return listId;
    const remainder = listId.slice(prefix.length);
    const separatorIndex = remainder.indexOf('__');
    return separatorIndex >= 0 ? remainder.slice(0, separatorIndex) : remainder;
  }

  trackColumn = (_: number, column: BoardColumn) => column.columnId;

  accentFor(column: BoardColumn): string {
    return this.categoryAccent[column.categoryHint] ?? '#9ca3af';
  }

  tasksForColumn(tasks: Task[] | null | undefined, column: BoardColumn): Task[] {
    const targetColumnId = column.columnId;
    return (tasks ?? []).filter(t => this.columnIdForTask(t) === targetColumnId);
  }

  isTaskInColumn(task: Task, column: BoardColumn): boolean {
    return this.columnIdForTask(task) === column.columnId;
  }

  private resetColumnTotals() {
    this.columnTotals = new Map(this.columns.map(col => [col.columnId, 0] as [string, number]));
  }

  private reindexColumns(cols: BoardColumn[]): BoardColumn[] {
    return cols.map((col, idx) => ({
      ...col,
      order: (idx + 1) * 10,
    }));
  }

  private nextColumnOrder(): number {
    if (!this.columns.length) return 0;
    return Math.max(...this.columns.map(col => Number(col.order ?? 0))) + 10;
  }

  private columnById(columnId: string): BoardColumn | undefined {
    return this.columns.find(col => col.columnId === columnId);
  }

  private statusForColumn(columnId: string): 'not_started'|'in_progress'|'done' {
    return this.columnById(columnId)?.categoryHint ?? 'not_started';
  }

  private progressForColumn(columnId: string): number {
    const column = this.columnById(columnId);
    if (!column) {
      return this.progressFallbackForCategory('not_started');
    }
    const value = Number(column.progressHint);
    if (!Number.isFinite(value)) {
      return this.progressFallbackForCategory(column.categoryHint);
    }
    return value;
  }

  private resolveColumnIdForCategory(category: BoardColumn['categoryHint']): string {
    const match = this.columns.find(col => col.categoryHint === category);
    if (match) return match.columnId;
    const exact = this.columns.find(col => col.columnId === category);
    if (exact) return exact.columnId;
    return this.columns[0]?.columnId ?? category;
  }

  private columnIdForTask(task: Task): string {
    if (task?.boardColumnId) {
      const column = this.columnById(task.boardColumnId);
      if (column) {
        return column.columnId;
      }
    }
    const bucket = this.bucket(task?.status);
    return this.resolveColumnIdForCategory(bucket);
  }

  private progressFallbackForCategory(category: BoardColumn['categoryHint']): number {
    switch (category) {
      case 'done':
        return 100;
      case 'in_progress':
        return 50;
      default:
        return 0;
    }
  }

  canEnter = (drag: CdkDrag, _drop: CdkDropList) => {
    if (!this.allowDnD) return false;
    const data = drag?.data as { task: Task; issueId: string } | undefined;
    const id = data?.task?.id;
    return !!id && !this.isBusy(id);
  };

  ngOnDestroy() {
    this.taskCountSubs.forEach(s => s.unsubscribe());
    this.taskCountSubs.clear();
  }

  private withPid(run: (pid: string) => void) {
    this.currentProject.projectId$.pipe(take(1)).subscribe(pid => {
      if (!pid || pid === 'default') {
        this.snack.open(this.tr.instant('common.projectNotSelected'), this.tr.instant('common.ok'), { duration: 2500 });
        return;
      }
      run(pid);
    });
  }

  bucket(s: Task['status'] | undefined): BoardColumn['categoryHint'] {
    if (s === 'done') return 'done';
    if (s === 'in_progress') return 'in_progress';
    return 'not_started';
  }

  async assignToMe(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireCanEdit())) return;
    const uid = await firstValueFrom(this.auth.uid$);
    if (!uid || !t.id) return;
    this.withPid(async pid => {
      this.busyTaskIds.add(t.id!);
      try { await this.tasks.assignMe(pid, problemId, issueId, t.id!, uid); }
      catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.assign'), this.tr.instant('common.ok'), { duration: 3000 }); }
      finally { this.busyTaskIds.delete(t.id!); }
    });
  }

  async unassignMe(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireCanEdit())) return;
    const uid = await firstValueFrom(this.auth.uid$);
    if (!uid || !t.id) return;
    this.withPid(async pid => {
      this.busyTaskIds.add(t.id!);
      try { await this.tasks.unassignMe(pid, problemId, issueId, t.id!, uid); }
      catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.unassign'), this.tr.instant('common.ok'), { duration: 3000 }); }
      finally { this.busyTaskIds.delete(t.id!); }
    });
  }

  private async requireCanEdit(): Promise<boolean> {
    const [isEditor, online] = await Promise.all([
      firstValueFrom(this.members.isEditor$),
      firstValueFrom(this.isOnline$),
    ]);
    if (!isEditor) {
      this.snack.open(this.tr.instant('warn.noEditPermission'), this.tr.instant('common.ok'), { duration: 3000 });
      return false;
    }
    if (!online) {
      this.snack.open(this.tr.instant('warn.offlineNoEdit'), this.tr.instant('common.ok'), { duration: 3000 });
      return false;
    }
    return true;
  }

  currentColumnTitle(t: Task): string {
    const colId = this.columnIdForTask(t);
    const col = this.columnById(colId);
    if (col) {
      return this.columnTitle(col);
    }
    return this.tr.instant(`board.col.${this.bucket(t.status)}`);
  }

  async moveTaskToColumn(
    problemId: string,
    issueId: string,
    t: Task,
    col: BoardColumn
  ) {
    if (!(await this.requireCanEdit())) return;
    if (!t.id || this.isBusy(t.id)) return;
    await this.setTaskStatus(problemId, issueId, t, col.columnId);
  }

  /** 担当者ツールチップ用：UID配列→表示名のCSV */
  assigneesTooltip(uids: string[] | null | undefined, dir: Record<string, string> | null | undefined): string {
    const xs = Array.isArray(uids) ? uids : [];
    if (!xs.length) return '';
    const map = dir ?? {};
    return xs.map(u => map[u] ?? u).join(', ');
  }

  private async requireAdminAssign(): Promise<boolean> {
    const [isAdmin, online] = await Promise.all([
      firstValueFrom(this.members.isAdmin$),
      firstValueFrom(this.isOnline$),
    ]);
    if (!isAdmin) {
      this.snack.open(this.tr.instant('warn.noEditPermission'), this.tr.instant('common.ok'), { duration: 3000 });
      return false;
    }
    if (!online) {
      this.snack.open(this.tr.instant('warn.offlineNoEdit'), this.tr.instant('common.ok'), { duration: 3000 });
      return false;
    }
    return true;
  }

  async toggleAdminAssignee(
    problemId: string,
    issueId: string,
    t: Task,
    targetUid: string
  ) {
    if (!t?.id || this.isBusy(t.id)) return;
    if (!(await this.requireAdminAssign())) return;
  
    const already = (t.assignees || []).includes(targetUid);
  
    this.withPid(async pid => {
      this.busyTaskIds.add(t.id!);
      try {
        if (already) {
          // Admin が付けた/ロックした割り当てを解除
          await this.tasks.forceUnassign(pid, problemId, issueId, t.id!, targetUid);
        } else {
          // Admin としてロック付きで割り当て
          await this.tasks.forceAssign(pid, problemId, issueId, t.id!, targetUid);
        }
      } catch (e) {
        console.error(e);
        this.snack.open(this.tr.instant('board.err.assign'), this.tr.instant('common.ok'), { duration: 3000 });
      } finally {
        this.busyTaskIds.delete(t.id!);
      }
    });
  }

  isLockedAssignee(t: Task | null | undefined, uid: string | null | undefined): boolean {
    if (!t || !uid) return false;
    const locks = Array.isArray((t as any).assigneeLocks)
      ? (t as any).assigneeLocks as string[]
      : [];
    return locks.includes(uid);
  }

}




