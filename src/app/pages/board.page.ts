// src/app/pages/board.page.ts
import { Component, DestroyRef } from '@angular/core';
import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable, BehaviorSubject, of, combineLatest, firstValueFrom } from 'rxjs';
import { switchMap, shareReplay, take, tap, map } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';

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
  imports: [AsyncPipe, NgFor, NgIf, FormsModule, MatButtonModule, RouterLink, DragDropModule, MatSnackBarModule, TranslateModule],
  template: `
    <div style="display:flex; align-items:center; gap:12px; margin:8px 0 16px;">
      <a mat-stroked-button routerLink="/tree">← {{ 'nav.tree' | translate }}</a>

      <label>
        {{ 'label.problem' | translate }}:
        <select [(ngModel)]="selectedProblemId" (ngModelChange)="onSelectProblem($event)">
          <option [ngValue]="null">{{ 'common.selectPrompt' | translate }}</option>
          <option *ngFor="let p of (problems$ | async)" [ngValue]="p.id">{{ p.title }}</option>
        </select>
      </label>

      <span style="flex:1 1 auto;"></span>

      <ng-container *ngIf="auth.loggedIn$ | async; else signinB">
        <span style="opacity:.8; margin-right:6px;">{{ (auth.displayName$ | async) || ('auth.signedIn' | translate) }}</span>
        <button mat-stroked-button type="button" (click)="auth.signOut()">{{ 'auth.signOut' | translate }}</button>
      </ng-container>
      <ng-template #signinB>
        <button mat-raised-button color="primary" type="button" (click)="auth.signInWithGoogle()">{{ 'auth.signIn' | translate }}</button>
      </ng-template>
    </div>

    <div *ngIf="!(isOnline$ | async)" style="margin:-8px 0 12px; font-size:12px; color:#b45309; background:#fffbeb; border:1px solid #fcd34d; padding:6px 8px; border-radius:6px;">
      {{ 'board.offlineNotice' | translate }}
    </div>

    <div *ngIf="!selectedProblemId" style="opacity:.7">{{ 'board.selectProblemHint' | translate }}</div>

    <ng-container *ngIf="selectedProblemId as pid">
      <div *ngIf="(issues$ | async) === null">{{ 'issue.loading' | translate }}</div>

      <div *ngIf="(issues$ | async) as issues">
        <div *ngIf="!issues.length" style="opacity:.7">{{ 'issue.noneYet' | translate }}</div>

        <div *ngIf="issues.length" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:12px;">
          <div
            *ngFor="let col of statusCols"
            style="border:1px solid #eee; border-radius:10px; padding:10px; min-height:80px;"
          >
            <div style="font-weight:600; margin-bottom:8px; display:flex; align-items:center; gap:8px;">
              <span>{{ ('board.col.' + col) | translate }}</span>
              <span style="display:inline-block; min-width:20px; padding:2px 6px; font-size:12px; line-height:1; text-align:center; border-radius:999px; border:1px solid #e5e7eb; background:#f8fafc;">
                {{ totals[col] }}
              </span>
            </div>

            <!-- 列内を Issue ごとにグループ表示 -->
            <ng-container *ngFor="let i of issues">
              <ng-container *ngIf="tasksMap[key(pid, i.id!)] | async as tasks">
                <ng-container *ngIf="tasksByStatus(tasks, col) as ts">
                  <div
                    cdkDropList
                    [cdkDropListData]="ts"
                    [cdkDropListConnectedTo]="listIds(i.id!)"
                    [id]="listId(col, i.id!)"
                    (cdkDropListDropped)="onListDrop($event, pid, i.id!)"
                    [cdkDropListEnterPredicate]="canEnter"
                    [cdkDropListDisabled]="!(canEdit$ | async)"
                    style="border:1px solid #e5e7eb; border-radius:10px; padding:8px; margin-bottom:10px; min-height:60px; transition:border-color .15s ease;"
                    (cdkDropListEntered)="($event.container.element.nativeElement.style.borderColor = '#9ca3af')"
                    (cdkDropListExited)="($event.container.element.nativeElement.style.borderColor = '#e5e7eb')"
                  >
                    <!-- Issueグループのヘッダ -->
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                      <div style="font-weight:600;">{{ i.title }}</div>
                      <span style="font-size:12px; opacity:.7;">{{ ts.length }} {{ 'board.items' | translate }}</span>
                    </div>

                    <!-- カード本体 -->
                    <div *ngFor="let t of ts; trackBy: trackTask"
                         cdkDrag
                         [cdkDragData]="{ task: t, issueId: i.id }"
                         [cdkDragDisabled]="isBusy(t.id!) || !(canEdit$ | async)"
                         [style.opacity]="(isBusy(t.id!) || !(canEdit$ | async)) ? 0.5 : 1"
                         style="border:1px solid #ddd; border-radius:8px; padding:8px; margin-bottom:6px;">
                      <ng-template cdkDragPreview>
                        <div style="border:1px solid #bbb; border-radius:8px; padding:8px; background:#fff;">
                          {{ t.title }}
                        </div>
                      </ng-template>
                      <ng-template cdkDragPlaceholder>
                        <div style="border:1px dashed #bbb; border-radius:8px; padding:8px; background:#fafafa;"></div>
                      </ng-template>

                      <div>{{ t.title }}</div>

                      <div style="display:flex; gap:6px; margin-top:6px;" *ngIf="isEditor$ | async">
                        <button mat-button *ngFor="let next of statusCols"
                                [disabled]="next===t.status || isBusy(t.id!) || !(canEdit$ | async)"
                                (click)="setTaskStatus(pid, i.id!, t, next)">
                          {{ ('board.col.' + next) | translate }}
                        </button>
                      </div>

                      <div style="display:flex; gap:6px; margin-top:6px;" *ngIf="auth.loggedIn$ | async">
                        <button mat-stroked-button
                                *ngIf="(members.isEditor$ | async) && !(t.assignees || []).includes((auth.uid$ | async) || '')"
                                [disabled]="isBusy(t.id!) || !(canEdit$ | async)"
                                (click)="assignToMe(pid, i.id!, t)">
                          {{ 'board.assignToMe' | translate }}
                        </button>
                        <button mat-stroked-button
                                *ngIf="(members.isEditor$ | async) && (t.assignees || []).includes((auth.uid$ | async) || '')"
                                [disabled]="isBusy(t.id!) || !(canEdit$ | async)"
                                (click)="unassignMe(pid, i.id!, t)">
                          {{ 'board.unassign' | translate }}
                        </button>
                        <span
                          style="font-size:12px; opacity:.75; align-self:center;"
                          *ngIf="(t.assignees?.length || 0) > 0">
                          👥 {{ t.assignees?.length || 0 }}
                        </span>

                      </div>

                    </div>

                    <!-- 空プレースホルダ -->
                    <div *ngIf="ts.length === 0"
                         style="padding:8px; border:1px dashed #d1d5db; border-radius:8px; text-align:center; opacity:.6; min-height: 100px;">
                      {{ 'board.dropHere' | translate }}
                    </div>
                  </div>
                </ng-container>
              </ng-container>
            </ng-container>
          </div>
        </div>
      </div>
    </ng-container>
  `
})
export class BoardPage {
  // 列定義（表示は翻訳キーで行う）
  statusCols = ['not_started','in_progress','done'] as const;

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

  private bucket(s: Task['status'] | undefined): 'not_started'|'in_progress'|'done' {
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

