import { Component, OnDestroy, OnInit } from '@angular/core';
import { AsyncPipe, NgFor, NgIf, NgSwitch, NgSwitchCase, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { Firestore } from '@angular/fire/firestore';
import { doc, getDoc, collection, getDocs } from 'firebase/firestore';
import { Observable, combineLatest, interval, of, from } from 'rxjs';
import { map, switchMap, startWith, filter, distinctUntilChanged, catchError, shareReplay, take } from 'rxjs/operators';

import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { Task } from '../models/types';
import { TaskRowComponent } from '../components/task-row/task-row.component';
import { TaskCalendarComponent } from '../components/task-calendar/task-calendar.component';

interface Vm {
  overdue: Task[];
  today: Task[];
  tomorrow: Task[];
  thisWeekRest: Task[];
  nextWeek: Task[];
  later: Task[];
  nodue: Task[];
}

const EMPTY_VM: Vm = {
  overdue: [],
  today: [],
  tomorrow: [],
  thisWeekRest: [],
  nextWeek: [],
  later: [],
  nodue: [],
};

interface SectionDef {
  key: keyof Vm;
  icon: string;
  label: string;
  accent: 'danger' | 'info' | 'muted';
}

interface MemberOption {
  uid: string;
  label: string;
}

@Component({
  standalone: true,
  selector: 'pp-schedule',
  templateUrl: './schedule.page.html',
  styleUrls: ['./schedule.page.scss'],
  imports: [
    AsyncPipe,
    NgFor,
    NgIf,
    NgSwitch,
    NgSwitchCase,
    NgTemplateOutlet, // ★ 追加（*ngTemplateOutlet 用）
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatIconModule,
    MatSelectModule,
    MatTooltipModule,
    TranslateModule,
    TaskRowComponent,
    TaskCalendarComponent,
  ],
})
export class SchedulePage implements OnInit, OnDestroy {
  vm$: Observable<Vm> = of(EMPTY_VM);
  openOnly = true;
  tagQuery = '';
  selectedAssignees: string[] = [];
  viewMode: 'list' | 'calendar' = 'list';
  calendarMonth = new Date();

  readonly sections: SectionDef[] = [
    { key: 'overdue', icon: 'warning', label: 'schedule.section.overdue', accent: 'danger' },
    { key: 'today', icon: 'event', label: 'schedule.section.today', accent: 'info' },
    { key: 'tomorrow', icon: 'event_available', label: 'schedule.section.tomorrow', accent: 'info' },
    { key: 'thisWeekRest', icon: 'date_range', label: 'schedule.section.thisWeekRest', accent: 'muted' },
    { key: 'nextWeek', icon: 'calendar_view_week', label: 'schedule.section.nextWeek', accent: 'muted' },
    { key: 'later', icon: 'calendar_month', label: 'schedule.section.later', accent: 'muted' },
    { key: 'nodue', icon: 'more_horiz', label: 'schedule.section.noDue', accent: 'muted' },
  ];

  private readonly midnightTick$ = interval(60_000).pipe(
    startWith(0),
    map(() => {
      const d = new Date();
      d.setSeconds(0, 0);
      return d.getHours() === 0 && d.getMinutes() === 0;
    }),
    distinctUntilChanged(),
    filter(Boolean),
  );

  private dueDateTimers = new Map<string, any>();

  // ★ TS2729回避：ここでは初期化しない
  members$!: Observable<MemberOption[]>;
  memberDirectory$!: Observable<Record<string, string>>;

  constructor(
    private tasks: TasksService,
    private currentProject: CurrentProjectService,
    private fs: Firestore,
  ) {}

  ngOnInit(): void {
    // members$ を起動時に組み立て（this.currentProject を安全に参照）
    this.members$ = this.currentProject.projectId$.pipe(
      switchMap(pid => {
        if (!pid || pid === 'default') return of<MemberOption[]>([]);
        const col = collection(this.fs as any, `projects/${pid}/members`);
        return from(getDocs(col)).pipe(
          map(snapshot =>
            snapshot.docs.map(docSnap => {
              const data: any = docSnap.data();
              return {
                uid: docSnap.id,
                label: data?.displayName || data?.email || docSnap.id,
              } as MemberOption;
            })
          ),
          catchError(() => of<MemberOption[]>([])),
        );
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.memberDirectory$ = this.members$.pipe(
      map(list => {
        const dir: Record<string, string> = {};
        for (const item of list) dir[item.uid] = item.label;
        return dir;
      }),
      startWith({} as Record<string, string>),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.reload();
  }

  ngOnDestroy(): void {
    this.dueDateTimers.forEach(timer => clearTimeout(timer));
    this.dueDateTimers.clear();
  }

  onViewModeChange(mode: 'list' | 'calendar') {
    this.viewMode = mode;
  }

  onOpenOnlyChange(value: boolean) {
    this.openOnly = value;
    this.reload();
  }

  onTagQueryChange() {
    this.reload();
  }

  onAssigneeChange() {
    this.reload();
  }

  onMonthChange(date: Date) {
    this.calendarMonth = date;
  }

  trackTask = (_: number, task: Task) => task.id;

  calendarTasks(vm: Vm): Task[] {
    return [
      ...vm.overdue,
      ...vm.today,
      ...vm.tomorrow,
      ...vm.thisWeekRest,
      ...vm.nextWeek,
      ...vm.later,
    ].filter(t => !!t.dueDate);
  }

  calendarUndated(vm: Vm): Task[] {
    return [...vm.nodue];
  }

  private parseTags(q: string): string[] {
    return (q || '')
      .split(/\s+/)
      .map(s => s.replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  private addDays(base: Date, n: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d;
  }

  private ymd(date: Date): string {
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, '0');
    const d = `${date.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private filterByAssignee(tasks: Task[]): Task[] {
    if (!this.selectedAssignees.length) return tasks;
    const set = new Set(this.selectedAssignees);
    return tasks.filter(task => (task.assignees ?? []).some(uid => set.has(uid)));
  }

  private applyAssigneeFilter(vm: Vm): Vm {
    if (!this.selectedAssignees.length) return vm;
    return {
      overdue: this.filterByAssignee(vm.overdue),
      today: this.filterByAssignee(vm.today),
      tomorrow: this.filterByAssignee(vm.tomorrow),
      thisWeekRest: this.filterByAssignee(vm.thisWeekRest),
      nextWeek: this.filterByAssignee(vm.nextWeek),
      later: this.filterByAssignee(vm.later),
      nodue: this.filterByAssignee(vm.nodue),
    };
  }

  reload() {
    const FAR_FUTURE = '9999-12-31';
    const tags = this.parseTags(this.tagQuery);
    const params$ = this.midnightTick$.pipe(startWith(null));

    this.vm$ = combineLatest([this.currentProject.projectId$, params$]).pipe(
      switchMap(([pid]) => {
        if (!pid || pid === 'default') return of(EMPTY_VM);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = this.addDays(today, 1);

        const dow = today.getDay();
        const diffToMon = (dow === 0 ? -6 : 1 - dow);
        const startOfWeek = this.addDays(today, diffToMon);
        const endOfWeek = this.addDays(startOfWeek, 6);
        const startOfNextWeek = this.addDays(endOfWeek, 1);
        const endOfNextWeek = this.addDays(startOfNextWeek, 6);

        const overdue$ = this.tasks.listAllOverdue(pid, this.ymd(today), this.openOnly, tags);
        const today$ = this.tasks.listAllByDueRange(pid, this.ymd(today), this.ymd(today), this.openOnly, tags);
        const tomorrow$ = this.tasks.listAllByDueRange(pid, this.ymd(tomorrow), this.ymd(tomorrow), this.openOnly, tags);
        const thisWeekRest$ = this.tasks.listAllByDueRange(pid, this.ymd(this.addDays(tomorrow, 1)), this.ymd(endOfWeek), this.openOnly, tags);
        const nextWeek$ = this.tasks.listAllByDueRange(pid, this.ymd(startOfNextWeek), this.ymd(endOfNextWeek), this.openOnly, tags);
        const later$ = this.tasks.listAllByDueRange(pid, this.ymd(this.addDays(endOfNextWeek, 1)), FAR_FUTURE, this.openOnly, tags);
        const nodue$ = this.tasks.listAllNoDue(pid, this.openOnly, tags);

        return combineLatest([overdue$, today$, tomorrow$, thisWeekRest$, nextWeek$, later$, nodue$]).pipe(
          map(([overdue, todayArr, tomorrowArr, thisWeekRest, nextWeek, later, nodue]) => this.applyAssigneeFilter({
            overdue,
            today: todayArr,
            tomorrow: tomorrowArr,
            thisWeekRest,
            nextWeek,
            later,
            nodue,
          })),
        );
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }

  onDueDateChange(event: { task: Task; dueDate: string | null }) {
    this.scheduleDueUpdate(event.task, event.dueDate);
  }

  private scheduleDueUpdate(task: Task, dueDate: string | null) {
    if (!task?.id || !task.projectId || !task.problemId || !task.issueId) return;
    const key = task.id;
    const prev = this.dueDateTimers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.tasks.update(task.projectId!, task.problemId!, task.issueId!, task.id!, { dueDate }).catch(err => console.error(err));
      this.dueDateTimers.delete(key);
    }, 400);
    this.dueDateTimers.set(key, timer);
  }

  async markDone(task: Task) {
    if (!task?.id || !task.projectId || !task.problemId || !task.issueId) return;
    try {
      await this.tasks.update(task.projectId, task.problemId, task.issueId, task.id, { status: 'done' as any });
    } catch (err) {
      console.error(err);
    }
  }

  shiftTask(task: Task, days: number) {
    if (!task.dueDate) return;
    const current = new Date(task.dueDate);
    if (isNaN(current.getTime())) return;
    current.setDate(current.getDate() + days);
    const next = this.ymd(current);
    this.scheduleDueUpdate(task, next);
  }

  setTaskToday(task: Task) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const next = this.ymd(today);
    this.scheduleDueUpdate(task, next);
  }

  private flattenVm(vm: Vm) {
    return [
      ...vm.overdue,
      ...vm.today,
      ...vm.tomorrow,
      ...vm.thisWeekRest,
      ...vm.nextWeek,
      ...vm.later,
      ...vm.nodue,
    ];
  }

  exportCurrent(kind: 'csv' | 'json') {
    this.vm$.pipe(take(1)).subscribe(async vm => {
      const data = this.flattenVm(vm);
      const nameMap = await this.resolveNames(data);
      const assigneeDir = await this.resolveAssigneeDirectory(data);
      if (kind === 'csv') {
        const csv = this.toCsv(data, nameMap, assigneeDir);
        this.download('schedule-tasks.csv', csv, 'text/csv');
      } else {
        const json = this.toJson(data, nameMap, assigneeDir);
        this.download('schedule-tasks.json', json, 'application/json');
      }
    });
  }

  private toCsv(tasks: Task[], nameMap: Map<string, string>, dir: Map<string, string>): string {
    const headers = ['ID', 'タイトル', '状態', '優先度', '期日', '担当者', 'プロジェクト', 'Problem', 'Issue', 'タグ', '進捗(%)', '作成日時', '更新日時'];
    const esc = (v: any) => `"${(v ?? '').toString().replace(/"/g, '""')}"`;
    const fmtTs = (x: any) => {
      const d = x?.toDate?.() ?? (typeof x === 'string' ? new Date(x) : null);
      return d && !isNaN(d as any) ? new Date(d).toISOString().replace('T', ' ').replace('Z', '') : '';
    };
    const joinAssignees = (xs: any) =>
      Array.isArray(xs) ? xs.map((u: string) => dir.get(u) ?? u).join(', ') : (xs ?? '');

    const rows = tasks.map(t => {
      const pj = t.projectId ? (nameMap.get(`project:${t.projectId}`) ?? t.projectId) : '';
      const pr = (t.projectId && t.problemId) ? (nameMap.get(`problem:${t.projectId}:${t.problemId}`) ?? t.problemId) : '';
      const is = (t.projectId && t.problemId && t.issueId) ? (nameMap.get(`issue:${t.projectId}:${t.problemId}:${t.issueId}`) ?? t.issueId) : '';
      return [
        t.id,
        t.title,
        t.status,
        t.priority ?? '',
        t.dueDate ?? '',
        joinAssignees(t.assignees),
        pj,
        pr,
        is,
        Array.isArray(t.tags) ? t.tags.join(', ') : (t.tags ?? ''),
        (t as any).progress ?? '',
        fmtTs((t as any).createdAt),
        fmtTs((t as any).updatedAt),
      ].map(esc).join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  private toJson(tasks: Task[], nameMap: Map<string, string>, dir: Map<string, string>): string {
    const mapped = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority ?? null,
      dueDate: t.dueDate ?? null,
      assignees: Array.isArray(t.assignees) ? t.assignees.map(u => dir.get(u) ?? u) : [],
      project: t.projectId ? (nameMap.get(`project:${t.projectId}`) ?? t.projectId) : null,
      problem: (t.projectId && t.problemId) ? (nameMap.get(`problem:${t.projectId}:${t.problemId}`) ?? t.problemId) : null,
      issue: (t.projectId && t.problemId && t.issueId) ? (nameMap.get(`issue:${t.projectId}:${t.problemId}:${t.issueId}`) ?? t.issueId) : null,
      tags: t.tags ?? [],
      progress: (t as any).progress ?? null,
      createdAt: (t as any).createdAt?.toDate?.() ?? null,
      updatedAt: (t as any).updatedAt?.toDate?.() ?? null,
      projectId: t.projectId ?? null,
      problemId: t.problemId ?? null,
      issueId: t.issueId ?? null,
    }));
    return JSON.stringify(mapped, null, 2);
  }

  private download(filename: string, content: string, mime = 'text/plain') {
    const bom = mime === 'text/csv' ? '\uFEFF' : '';
    const blob = new Blob([bom + content], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private async resolveNames(tasks: Task[]): Promise<Map<string, string>> {
    const nameMap = new Map<string, string>();
    const needProject = new Set<string>();
    const needProblem: Array<{ pid: string; problemId: string }> = [];
    const needIssue: Array<{ pid: string; problemId: string; issueId: string }> = [];

    for (const t of tasks) {
      if (t.projectId) needProject.add(t.projectId);
      if (t.projectId && t.problemId) needProblem.push({ pid: t.projectId, problemId: t.problemId });
      if (t.projectId && t.problemId && t.issueId) needIssue.push({ pid: t.projectId, problemId: t.problemId, issueId: t.issueId });
    }

    await Promise.all(Array.from(needProject).map(async pid => {
      const snap = await getDoc(doc(this.fs as any, `projects/${pid}`));
      const name = snap.exists() ? (snap.data() as any)?.meta?.name ?? pid : pid;
      nameMap.set(`project:${pid}`, name);
    }));

    await Promise.all(needProblem.map(async x => {
      const key = `problem:${x.pid}:${x.problemId}`;
      if (nameMap.has(key)) return;
      const snap = await getDoc(doc(this.fs as any, `projects/${x.pid}/problems/${x.problemId}`));
      const title = snap.exists() ? (snap.data() as any)?.title ?? x.problemId : x.problemId;
      nameMap.set(key, title);
    }));

    await Promise.all(needIssue.map(async x => {
      const key = `issue:${x.pid}:${x.problemId}:${x.issueId}`;
      if (nameMap.has(key)) return;
      const snap = await getDoc(doc(this.fs as any, `projects/${x.pid}/problems/${x.problemId}/issues/${x.issueId}`));
      const title = snap.exists() ? (snap.data() as any)?.title ?? x.issueId : x.issueId;
      nameMap.set(key, title);
    }));

    return nameMap;
  }

  private async resolveAssigneeDirectory(tasks: Task[]): Promise<Map<string, string>> {
    const byUid = new Map<string, string>();
    const pids = Array.from(new Set(tasks.map(t => t.projectId).filter(Boolean))) as string[];

    for (const pid of pids) {
      const col = collection(this.fs as any, `projects/${pid}/members`);
      const snap = await getDocs(col);
      snap.forEach(docSnap => {
        const d: any = docSnap.data();
        const label = d?.displayName || d?.email || docSnap.id;
        byUid.set(docSnap.id, label);
      });
    }
    return byUid;
  }
}

