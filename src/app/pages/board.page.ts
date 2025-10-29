// src/app/pages/board.page.ts
import { Component, DestroyRef } from '@angular/core';
import { AsyncPipe, DatePipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable, BehaviorSubject, of, combineLatest, firstValueFrom } from 'rxjs';
import { switchMap, shareReplay, take, tap, map, distinctUntilChanged } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';

import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { Problem, Issue, Task } from '../models/types';

import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem, CdkDrag, CdkDropList } from '@angular/cdk/drag-drop';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../services/auth.service';
import { MembersService } from '../services/members.service';
import { NetworkService } from '../services/network.service';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { TranslateModule, TranslateService } from '@ngx-translate/core'; // ★ 追加

@Component({
  standalone: true,
  selector: 'pp-board',
  imports: [
    AsyncPipe, NgFor, NgIf, DatePipe,
    FormsModule,
    MatButtonModule, MatIconModule, MatFormFieldModule, MatSelectModule, MatCardModule, MatChipsModule,
    DragDropModule, MatSnackBarModule, TranslateModule
  ],
  templateUrl: './board.page.html',
  styleUrls: ['./board.page.scss']
})
export class BoardPage {
  // 列定義（表示は翻訳キーで行う）
  statusCols = ['not_started','in_progress','done'] as const;

  readonly colAccent: Record<(typeof this.statusCols)[number], string> = {
    not_started: '#9ca3af',
    in_progress: '#0ea5e9',
    done: '#22c55e'
  };

  problems$!: Observable<Problem[]>;
  selectedProblemId: string | null = null;

  private selectedProblem$ = new BehaviorSubject<string | null>(null);
  issues$: Observable<Issue[] | null> = of(null);

  totals: Record<'not_started'|'in_progress'|'done', number> = { not_started: 0, in_progress: 0, done: 0 };

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
    public members: MembersService,
    private network: NetworkService,
    private snack: MatSnackBar,
    private tr: TranslateService, // ★ 追加
  ) {
    this.isEditor$ = this.members.isEditor$;
    this.isOnline$ = this.network.isOnline$;
    this.canEdit$ = combineLatest([this.members.isEditor$, this.network.isOnline$]).pipe(
      map(([isEditor, online]) => !!isEditor && !!online)
    );
  }

  allowDnD = false;

  ngOnInit() {
    this.problems$ = this.currentProject.projectId$.pipe(
      switchMap(pid => (pid && pid !== 'default') ? this.problems.list(pid) : of([]))
    );

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
    this.totals = { not_started: 0, in_progress: 0, done: 0 };
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
    const t = { not_started: 0, in_progress: 0, done: 0 } as Record<'not_started'|'in_progress'|'done', number>;
    for (const list of Object.values(this.tasksSnapshot)) {
      for (const x of list) {
        if (x.status === 'done') t.done++;
        else if (x.status === 'in_progress') t.in_progress++;
        else t.not_started++;
      }
    }
    this.totals = t;
  }

  async setTaskStatus(
    problemId: string,
    issueId: string,
    t: Task,
    status: 'not_started'|'in_progress'|'done'
  ) {
    if (!(await this.requireCanEdit())) return;
    if (!t.id || this.isBusy(t.id)) return;
    const progress = status === 'done' ? 100 : status === 'not_started' ? 0 : 50;

    this.busyTaskIds.add(t.id);
    this.withPid(async pid => {
      try { await this.tasks.update(pid, problemId, issueId, t.id!, { status, progress }); }
      catch (e) { console.error(e); this.snack.open(this.tr.instant('board.err.update'), 'OK', { duration: 3000 }); }
      finally { this.busyTaskIds.delete(t.id!); }
    });
  }

  async onListDrop(ev: CdkDragDrop<Task[]>, problemId: string, issueId: string) {
    if (!(await this.requireCanEdit())) return;

    const parse = (id: string) => id.split('-')[1] as 'not_started'|'in_progress'|'done';
    const srcStatus  = parse(ev.previousContainer.id);
    const destStatus = parse(ev.container.id);

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
    const progress = destStatus === 'done' ? 100 : destStatus === 'not_started' ? 0 : 50;

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
    return (['not_started','in_progress','done'] as const).map(s => this.listId(s, issueId));
  }
  listId(status: 'not_started'|'in_progress'|'done', issueId: string): string {
    return `dl-${status}-${issueId}`;
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

  bucket(s: Task['status'] | undefined): 'not_started'|'in_progress'|'done' {
    if (s === 'done') return 'done';
    if (s === 'in_progress' || s === 'review_wait' || s === 'fixing') return 'in_progress';
    return 'not_started';
  }

  tasksByStatus(tasks: Task[] | null | undefined, status: 'not_started'|'in_progress'|'done'): Task[] {
    return (tasks ?? []).filter(t => this.bucket(t.status) === status);
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

