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

import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { Problem, Issue, Task, BoardColumn, DEFAULT_BOARD_COLUMNS } from '../models/types';
import { BoardColumnsService } from '../services/board-columns.service';
import { BoardColumnEditDialogComponent, BoardColumnEditDialogResult } from '../components/board-column-edit-dialog.component';

import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem, CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../services/auth.service';
import { MembersService } from '../services/members.service';
import { NetworkService } from '../services/network.service';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  standalone: true,
  selector: 'pp-board',
  imports: [
    AsyncPipe, NgFor, NgIf, NgClass, DatePipe,
    FormsModule,
    MatButtonModule, MatIconModule, MatFormFieldModule, MatSelectModule, MatCardModule, MatChipsModule,
    DragDropModule, MatSnackBarModule, TranslateModule, MatDialogModule
  ],
  templateUrl: './board.page.html',
  styleUrls: ['./board.page.scss']
})
export class BoardPage {
  columns: BoardColumn[] = DEFAULT_BOARD_COLUMNS;

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

  isEditor$!: Observable<boolean>;
  isOnline$!: Observable<boolean>;
  canEdit$!: Observable<boolean>;

  busyTaskIds = new Set<string>();
  isBusy(id: string | undefined | null): boolean { return !!id && this.busyTaskIds.has(id); }

  tasksMap: Record<string, Observable<Task[]>> = {};
  private taskCountSubs = new Map<string, import('rxjs').Subscription>();
  private tasksSnapshot: Record<string, Task[]> = {};

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
  ) {
    this.isEditor$ = this.members.isEditor$;
    this.isOnline$ = this.network.isOnline$;
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
        this.snack.open('保存しました', 'OK', { duration: 2500 });
      } catch (err) {
        console.error('[BoardPage] Failed to update column', err);
        this.snack.open('保存に失敗しました', 'OK', { duration: 3000 });
      }
    });
  }

  allowDnD = false;

  ngOnInit() {
    this.problems$ = this.currentProject.projectId$.pipe(
      switchMap(pid => (pid && pid !== 'default') ? this.problems.list(pid) : of([]))
    );

    this.currentProject.projectId$
      .pipe(
        switchMap(pid =>
          (pid && pid !== 'default')
            ? this.boardColumns.list(pid)
            : of(DEFAULT_BOARD_COLUMNS)
        ),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(cols => {
        console.log('[BoardPage] received columns =', cols);

        // いま使ってるプロジェクトIDも一緒に確認したいので、直近の pid をもう一回覗く:
        this.currentProject.projectId$.pipe(take(1)).subscribe(latestPid => {
          console.log('[BoardPage] latestPid =', latestPid);
        });

        this.columns = cols;
        this.resetColumnTotals();
        this.recalcTotals();
      });


    this.canEdit$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(v => this.allowDnD = !!v);

    this.issues$ = this.selectedProblem$.pipe(
      distinctUntilChanged(),
      switchMap(problemId => this.currentProject.projectId$.pipe(
        switchMap(pid => (pid && pid !== 'default' && problemId) ? this.issues.listByProblem(pid, problemId) : of([])),
        tap(list => this.setupTaskStreams(problemId, list))
      ))
    );

    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(m => {
        const pid = m.get('pid');
        this.selectedProblemId = pid;
        this.selectedProblem$.next(pid);
      });
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
        this.tasksMap[k] = this.currentProject.projectId$.pipe(
          switchMap(pid => (pid && pid !== 'default') ? this.tasks.listByIssue(pid, problemId, i.id!) : of([])),
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
        const columnId = this.resolveColumnIdForCategory(this.bucket(x.status));
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

    this.busyTaskIds.add(t.id);
    this.withPid(async pid => {
      try { await this.tasks.update(pid, problemId, issueId, t.id!, { status, progress }); }
      catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.update'), 'OK', { duration: 3000 }); }
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

    this.busyTaskIds.add(moved.id);
    this.withPid(async pid => {
      try { await this.tasks.update(pid, problemId, issueId, id, { status: destStatus, progress }); }
      catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.statusUpdate'), 'OK', { duration: 3000 }); }
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
        catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.orderSave'), 'OK', { duration: 3000 }); }
        finally { this.busyTaskIds.delete(u.id); }
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
    return (tasks ?? []).filter(t => this.resolveColumnIdForCategory(this.bucket(t.status)) === targetColumnId);
  }

  isTaskInColumn(task: Task, column: BoardColumn): boolean {
    return this.resolveColumnIdForCategory(this.bucket(task.status)) === column.columnId;
  }

  private resetColumnTotals() {
    this.columnTotals = new Map(this.columns.map(col => [col.columnId, 0] as [string, number]));
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
    const exact = this.columns.find(col => col.columnId === category);
    if (exact) return exact.columnId;
    const match = this.columns.find(col => col.categoryHint === category);
    if (match) return match.columnId;
    return this.columns[0]?.columnId ?? category;
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
        this.snack.open(this.tr.instant('common.projectNotSelected'), 'OK', { duration: 2500 });
        return;
      }
      run(pid);
    });
  }

  bucket(s: Task['status'] | undefined): BoardColumn['categoryHint'] {
    if (s === 'done') return 'done';
    if (s === 'in_progress' || s === 'review_wait' || s === 'fixing') return 'in_progress';
    return 'not_started';
  }

  async assignToMe(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireCanEdit())) return;
    const uid = await firstValueFrom(this.auth.uid$);
    if (!uid || !t.id) return;
    this.withPid(async pid => {
      this.busyTaskIds.add(t.id!);
      try { await this.tasks.assignMe(pid, problemId, issueId, t.id!, uid); }
      catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.assign'), 'OK', { duration: 3000 }); }
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
      catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.unassign'), 'OK', { duration: 3000 }); }
      finally { this.busyTaskIds.delete(t.id!); }
    });
  }

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
}

