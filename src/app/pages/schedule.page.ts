import { Component, OnDestroy, OnInit } from '@angular/core';
import { AsyncPipe, NgFor, NgIf, NgClass, NgSwitch, NgSwitchCase, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule, DateAdapter } from '@angular/material/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Firestore } from '@angular/fire/firestore';
import { doc, getDoc, collection, getDocs, query as nativeQuery } from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';
import { Observable, combineLatest, interval, of } from 'rxjs';
import { map, switchMap, startWith, filter, distinctUntilChanged, shareReplay, take } from 'rxjs/operators';
import { safeFromProject$ } from '../utils/rx-safe';

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
    AsyncPipe, NgFor, NgIf, NgClass, NgSwitch, NgSwitchCase, NgTemplateOutlet,
    FormsModule,
    MatButtonModule, MatButtonToggleModule, MatCardModule, MatIconModule,
    MatSelectModule, MatTooltipModule,
    // ▼ 追加（マイページと同じ Datepicker 群）
    MatFormFieldModule, MatInputModule, MatDatepickerModule, MatNativeDateModule,
    TranslateModule,
    TaskRowComponent, TaskCalendarComponent,
  ],
})
export class SchedulePage implements OnInit, OnDestroy {
  vm$: Observable<Vm> = of(EMPTY_VM);

  openOnly = true;
  tagQuery = '';
  selectedAssignees: string[] = [];

  // ▼ マイページと同じ「表示用 Date」と「クエリ文字列(YYYY-MM-DD)」
  displayStartDate: Date | null = null;
  displayEndDate: Date | null = null;
  startRange = '';
  endRange = '';

  viewMode: 'list' | 'calendar' = 'list';
  calendarMonth = new Date();

  readonly sections: SectionDef[] = [
    { key: 'overdue',      icon: 'warning_amber',      label: 'schedule.section.overdue',      accent: 'danger' },
    { key: 'today',        icon: 'today',              label: 'schedule.section.today',        accent: 'info' },
    { key: 'tomorrow',     icon: 'event_available',    label: 'schedule.section.tomorrow',     accent: 'info' },
    { key: 'thisWeekRest', icon: 'date_range',         label: 'schedule.section.thisWeekRest', accent: 'muted' },
    { key: 'nextWeek',     icon: 'calendar_view_week', label: 'schedule.section.nextWeek',     accent: 'muted' },
    { key: 'later',        icon: 'calendar_month',     label: 'schedule.section.later',        accent: 'muted' },
    { key: 'nodue',        icon: 'more_time',          label: 'schedule.section.noDue',        accent: 'muted' },
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
  private inFlight = new Set<string>();

  members$!: Observable<MemberOption[]>;
  memberDirectory$!: Observable<Record<string, string>>;

  constructor(
    private tasks: TasksService,
    private currentProject: CurrentProjectService,
    private fs: Firestore,
    private tr: TranslateService,
    private dateAdapter: DateAdapter<Date>,
  ) {}

  // ===== Date ⇄ YYYY-MM-DD =====
  private toDate(s?: string | null): Date | null {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  private toYmd(d?: Date | null): string {
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ===== 期間UIイベント =====
  onStartPicked(date: Date | null) {
    this.displayStartDate = date;
    this.startRange = date ? this.toYmd(date) : '';
    this.onDateRangeChange();
  }
  onEndPicked(date: Date | null) {
    this.displayEndDate = date;
    this.endRange = date ? this.toYmd(date) : '';
    this.onDateRangeChange();
  }
  clearStart() {
    this.displayStartDate = null;
    this.startRange = '';
    this.onDateRangeChange();
  }
  clearEnd() {
    this.displayEndDate = null;
    this.endRange = '';
    this.onDateRangeChange();
  }

  // ===== i18n → Datepicker ロケール追従 =====
  private applyLocaleFromI18n() {
    const l = (this.tr.currentLang || '').toLowerCase();
    this.dateAdapter.setLocale(l.startsWith('en') ? 'en-US' : 'ja-JP');
  }

  ngOnInit(): void {
    this.applyLocaleFromI18n();
    this.tr.onLangChange.subscribe(() => this.applyLocaleFromI18n());

    // リロード時の復元
    this.displayStartDate = this.toDate(this.startRange);
    this.displayEndDate = this.toDate(this.endRange);

    // メンバー
    this.members$ = safeFromProject$(
      this.currentProject.projectId$,
      pid => {
        const col = collection(this.fs as any, `projects/${pid}/members`);
        const q = nativeQuery(col);
        return (rxCollectionData(q, { idField: 'id' }) as Observable<any[]>).pipe(
          map(docs => docs.map((docSnap: any) => {
            const data: any = docSnap;
            return { uid: docSnap.id || '', label: data?.displayName || data?.email || docSnap.id || '' } as MemberOption;
          }))
        );
      },
      [] as MemberOption[]
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
    this.dueDateTimers.forEach(t => clearTimeout(t));
    this.dueDateTimers.clear();
    this.inFlight.clear();
  }

  // ---- UI handlers ----
  onViewModeChange(mode: 'list' | 'calendar') { this.viewMode = mode; }
  onOpenOnlyChange(value: boolean) { this.openOnly = value; this.reload(); }
  onTagQueryChange() { this.reload(); }
  onAssigneeChange() { this.reload(); }
  onDateRangeChange() { this.reload(); }
  onMonthChange(date: Date) { this.calendarMonth = date; }

  trackTask = (_: number, task: Task) => task.id;

  isBusy(id?: string): boolean {
    return !!id && this.inFlight.has(id);
  }

  // ---- Calendar helpers ----
  calendarTasks(vm: Vm): Task[] {
    return [
      ...vm.overdue, ...vm.today, ...vm.tomorrow,
      ...vm.thisWeekRest, ...vm.nextWeek, ...vm.later,
    ].filter(t => !!t.dueDate);
  }
  calendarUndated(vm: Vm): Task[] { return [...vm.nodue]; }

  // ---- Util ----
  private parseTags(q: string): string[] {
    return (q || '').split(/\s+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean).slice(0, 10);
  }
  private addDays(base: Date, n: number): Date { const d = new Date(base); d.setDate(d.getDate() + n); return d; }
  private ymd(date: Date): string {
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, '0');
    const d = `${date.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  private sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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

  /** 重複排除（先勝ち） */
  private dedupeBuckets(vm: Vm): Vm {
    const used = new Set<string>();
    const take = (xs: Task[]) => xs.filter(t => {
      const id = t.id!;
      if (used.has(id)) return false;
      used.add(id);
      return true;
    });
    return {
      overdue:      take(vm.overdue),
      today:        take(vm.today),
      tomorrow:     take(vm.tomorrow),
      thisWeekRest: take(vm.thisWeekRest),
      nextWeek:     take(vm.nextWeek),
      later:        take(vm.later),
      nodue:        take(vm.nodue),
    };
  }

  // 追加: ISO日付のクランプ系（マイページと同じ）
  private minIso(a: string, b: string) { return a <= b ? a : b; }
  private maxIso(a: string, b: string) { return a >= b ? a : b; }
  private validRange(from: string, to: string) { return from <= to; }

  reload() {
    const FAR_FUTURE = '9999-12-31';
    const tags = this.parseTags(this.tagQuery);
    const params$ = this.midnightTick$.pipe(startWith(null));
  
    this.vm$ = combineLatest([this.currentProject.projectId$, params$]).pipe(
      switchMap(([pid]) => {
        if (!pid) return of(EMPTY_VM);
  
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const tomorrow = this.addDays(today, 1);
  
        const dow = today.getDay();
        const diffToMon = (dow === 0 ? -6 : 1 - dow);
        const startOfWeek = this.addDays(today, diffToMon);
        const endOfWeek = this.addDays(startOfWeek, 6);
        const startOfNextWeek = this.addDays(endOfWeek, 1);
        const endOfNextWeek = this.addDays(startOfNextWeek, 6);
  
        // 「明日」が来週月と重なる場合は来週Startを+1日（従来対処のまま）
        let nextWeekStart = startOfNextWeek;
        if (this.sameDay(tomorrow, startOfNextWeek)) nextWeekStart = this.addDays(startOfNextWeek, 1);
  
        // 入力レンジ（未指定は最小～最大）
        const start = this.startRange || '0000-01-01';
        const end = this.endRange || FAR_FUTURE;
  
        // ISO文字列
        const isoToday = this.ymd(today);
        const isoTomorrow = this.ymd(tomorrow);
        const isoThisWeekRestStart = this.ymd(this.addDays(tomorrow, 1));
        const isoEndOfWeek = this.ymd(endOfWeek);
        const isoStartOfNextWeek = this.ymd(nextWeekStart);
        const isoEndOfNextWeek = this.ymd(endOfNextWeek);
        const isoAfterNextWeek = this.ymd(this.addDays(endOfNextWeek, 1));
  
        // ---- start/end でクランプしたクエリに統一 ----
  
        // 1) 今日まで（start～min(end, today)）を一度に取り、overdue / today に分割
        const toTodayStart = start;
        const toTodayEnd = this.minIso(end, isoToday);
        const allToToday$ = (toTodayStart <= toTodayEnd)
          ? this.tasks.listAllByDueRange$(pid, toTodayStart, toTodayEnd, this.openOnly, tags)
          : of([] as Task[]);
        const overdue$ = allToToday$.pipe(map(xs => xs.filter(x => (x.dueDate ?? '') < isoToday)));
        const today$   = allToToday$.pipe(map(xs => xs.filter(x => x.dueDate === isoToday)));
  
        // 2) 明日（start <= 明日 <= end のとき）
        const tomorrow$ = (start <= isoTomorrow && isoTomorrow <= end)
          ? this.tasks.listAllByDueRange$(pid, isoTomorrow, isoTomorrow, this.openOnly, tags)
          : of([] as Task[]);
  
        // 3) 今週の残り [max(start, 今週残り開始) .. min(end, 週末)]
        const wRestStart = this.maxIso(start, isoThisWeekRestStart);
        const wRestEnd   = this.minIso(end, isoEndOfWeek);
        const thisWeekRest$ = (wRestStart <= wRestEnd)
          ? this.tasks.listAllByDueRange$(pid, wRestStart, wRestEnd, this.openOnly, tags)
          : of([] as Task[]);
  
        // 4) 来週 [max(start, 来週開始) .. min(end, 来週末)]
        const nextStart = this.maxIso(start, isoStartOfNextWeek);
        const nextEnd   = this.minIso(end, isoEndOfNextWeek);
        const nextWeek$ = (nextStart <= nextEnd)
          ? this.tasks.listAllByDueRange$(pid, nextStart, nextEnd, this.openOnly, tags)
          : of([] as Task[]);
  
        // 5) 以降 [max(start, 来週末+1) .. end]
        const laterStart = this.maxIso(start, isoAfterNextWeek);
        const later$ = (laterStart <= end)
          ? this.tasks.listAllByDueRange$(pid, laterStart, end, this.openOnly, tags)
          : of([] as Task[]);
  
        // 6) 期限なし（そのまま）
        const nodue$ = this.tasks.listAllNoDue$(pid, this.openOnly, tags);
  
        return combineLatest([overdue$, today$, tomorrow$, thisWeekRest$, nextWeek$, later$, nodue$]).pipe(
          map(([overdue, todayArr, tomorrowArr, thisWeekRest, nextWeekArr, laterArr, nodue]) => {
            const vmRaw: Vm = { overdue, today: todayArr, tomorrow: tomorrowArr, thisWeekRest, nextWeek: nextWeekArr, later: laterArr, nodue };
            return this.applyAssigneeFilter(this.dedupeBuckets(vmRaw));
          }),
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
    const key = task.id!;
    const prevTimer = this.dueDateTimers.get(key);
    if (prevTimer) clearTimeout(prevTimer);
    this.inFlight.add(key);
    const timer = setTimeout(() => {
      this.tasks.update(task.projectId!, task.problemId!, task.issueId!, key, { dueDate })
        .catch(err => console.error(err))
        .finally(() => {
          this.inFlight.delete(key);
          this.dueDateTimers.delete(key);
        });
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
    const id = task.id!;
    if (this.inFlight.has(id)) return;
    const current = new Date(task.dueDate);
    if (isNaN(current.getTime())) return;
    current.setDate(current.getDate() + days);
    this.scheduleDueUpdate(task, this.ymd(current));
  }

  setTaskToday(task: Task) {
    const id = task.id!;
    if (this.inFlight.has(id)) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    this.scheduleDueUpdate(task, this.ymd(today));
  }

  private flattenVm(vm: Vm) {
    return [
      ...vm.overdue, ...vm.today, ...vm.tomorrow,
      ...vm.thisWeekRest, ...vm.nextWeek, ...vm.later, ...vm.nodue,
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

  private statusI18nKey(raw: any): 'done' | 'inProgress' | 'notStarted' {
    if (raw === 'done') return 'done';
    if (raw === 'in_progress') return 'inProgress';
    if (raw === 'not_started') return 'notStarted';
    return 'notStarted';
  }
  private labelStatus(raw: any): string { return this.tr.instant(`status.${this.statusI18nKey(raw)}`); }
  private labelPriority(raw: any): string { return raw ? this.tr.instant(`priority.${raw}`) : this.tr.instant('common.none'); }

  private toCsv(tasks: Task[], nameMap: Map<string, string>, dir: Map<string, string>): string {
    const headers = [
      this.tr.instant('schedule.export.headers.id'),
      this.tr.instant('schedule.export.headers.title'),
      this.tr.instant('schedule.export.headers.status'),
      this.tr.instant('schedule.export.headers.priority'),
      this.tr.instant('schedule.export.headers.due'),
      this.tr.instant('schedule.export.headers.assignees'),
      this.tr.instant('schedule.export.headers.project'),
      this.tr.instant('schedule.export.headers.problem'),
      this.tr.instant('schedule.export.headers.issue'),
      this.tr.instant('schedule.export.headers.tags'),
      this.tr.instant('schedule.export.headers.progress'),
      this.tr.instant('schedule.export.headers.createdAt'),
      this.tr.instant('schedule.export.headers.updatedAt'),
    ];
    const esc = (v: any) => `"${(v ?? '').toString().replace(/"/g, '""')}"`;
    const fmtTs = (x: any) => {
      const d = x?.toDate?.() ?? (typeof x === 'string' ? new Date(x) : null);
      return d && !isNaN(d as any) ? new Date(d).toISOString().replace('T', ' ').replace('Z', '') : '';
    };
    const joinAssignees = (xs: any) => Array.isArray(xs) ? xs.map((u: string) => dir.get(u) ?? u).join(', ') : (xs ?? '');
    const rows = tasks.map(t => {
      const pj = t.projectId ? (nameMap.get(`project:${t.projectId}`) ?? t.projectId) : '';
      const pr = (t.projectId && t.problemId) ? (nameMap.get(`problem:${t.projectId}:${t.problemId}`) ?? t.problemId) : '';
      const is = (t.projectId && t.problemId && t.issueId) ? (nameMap.get(`issue:${t.projectId}:${t.problemId}:${t.issueId}`) ?? t.issueId) : '';
      return [
        t.id, t.title, this.labelStatus((t as any).status), this.labelPriority((t as any).priority),
        t.dueDate ?? '', joinAssignees(t.assignees), pj, pr, is,
        Array.isArray(t.tags) ? t.tags.join(', ') : (t.tags ?? ''),
        (t as any).progress ?? '', fmtTs((t as any).createdAt), fmtTs((t as any).updatedAt),
      ].map(esc).join(',');
    });
    return [headers.join(','), ...rows].join('\n');
  }

  private toJson(tasks: Task[], nameMap: Map<string, string>, dir: Map<string, string>): string {
    const mapped = tasks.map(t => ({
      id: t.id, title: t.title,
      status: (t as any).status, priority: (t as any).priority ?? null,
      dueDate: t.dueDate ?? null,
      assignees: Array.isArray(t.assignees) ? t.assignees.map(u => dir.get(u) ?? u) : [],
      project: t.projectId ? (nameMap.get(`project:${t.projectId}`) ?? t.projectId) : null,
      problem: (t.projectId && t.problemId) ? (nameMap.get(`problem:${t.projectId}:${t.problemId}`) ?? t.problemId) : null,
      issue: (t.projectId && t.problemId && t.issueId) ? (nameMap.get(`issue:${t.projectId}:${t.problemId}:${t.issueId}`) ?? t.issueId) : null,
      tags: t.tags ?? [], progress: (t as any).progress ?? null,
      createdAt: (t as any).createdAt?.toDate?.() ?? null,
      updatedAt: (t as any).updatedAt?.toDate?.() ?? null,
      projectId: t.projectId ?? null, problemId: t.problemId ?? null, issueId: t.issueId ?? null,
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



