// src/app/pages/my-tasks.page.ts
import { Component, OnDestroy, OnInit } from '@angular/core';
import { AsyncPipe, NgFor, NgIf, NgClass, NgSwitch, NgSwitchCase, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule, DateAdapter } from '@angular/material/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Firestore } from '@angular/fire/firestore';
import { doc, getDoc, collection, getDocs, query as nativeQuery } from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';
import { Observable, combineLatest, interval, of, Subscription } from 'rxjs';
import { map, switchMap, startWith, filter, distinctUntilChanged, shareReplay, take } from 'rxjs/operators';
import { safeFromProject$ } from '../utils/rx-safe';

import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { AuthService } from '../services/auth.service';
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
  overdue: [], today: [], tomorrow: [], thisWeekRest: [], nextWeek: [], later: [], nodue: [],
};

interface SectionDef {
  key: keyof Vm;
  icon: string;
  label: string; // i18n key
  accent: 'danger' | 'info' | 'muted';
}

interface MemberOption {
  uid: string;
  label: string;
}

@Component({
  standalone: true,
  selector: 'pp-my-tasks',
  templateUrl: './my-tasks.page.html',
  styleUrls: ['./my-tasks.page.scss'],
  imports: [
    AsyncPipe, NgFor, NgIf, NgClass, NgSwitch, NgSwitchCase, NgTemplateOutlet,
    FormsModule,
    MatButtonModule, MatButtonToggleModule, MatCardModule, MatIconModule,
    MatTooltipModule, MatProgressBarModule,
    // ▼ 追加（疑似入力フォーム = Material Datepicker）
    MatFormFieldModule, MatInputModule, MatDatepickerModule, MatNativeDateModule,
    TranslateModule,
    TaskRowComponent, TaskCalendarComponent,
  ],
})
export class MyTasksPage implements OnInit, OnDestroy {
  vm$: Observable<Vm> = of(EMPTY_VM);

  openOnly = true;
  tagQuery = '';

  // 内部保持：表示用の日付（Material DatepickerはDate型が扱いやすい）
  displayStartDate: Date | null = null;
  displayEndDate: Date | null = null;

  // 既存のクエリ文字列（YYYY-MM-DD）
  startRange = '';
  endRange = '';

  viewMode: 'list' | 'calendar' = 'list';
  calendarMonth = new Date();

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

  readonly sections: SectionDef[] = [
    { key: 'overdue',      icon: 'warning_amber',      label: 'myTasks.overdue',      accent: 'danger' },
    { key: 'today',        icon: 'today',              label: 'myTasks.today',        accent: 'info'   },
    { key: 'tomorrow',     icon: 'event_available',    label: 'myTasks.tomorrow',     accent: 'info'   },
    { key: 'thisWeekRest', icon: 'date_range',         label: 'myTasks.thisWeekRest', accent: 'muted'  },
    { key: 'nextWeek',     icon: 'calendar_view_week', label: 'myTasks.nextWeek',     accent: 'muted'  },
    { key: 'later',        icon: 'calendar_month',     label: 'myTasks.later',        accent: 'muted'  },
    { key: 'nodue',        icon: 'more_time',          label: 'myTasks.nodue',        accent: 'muted'  },
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

  private langSub?: Subscription; // 言語切替の購読

  members$!: Observable<MemberOption[]>;
  memberDirectory$!: Observable<Record<string, string>>;

  constructor(
    private tasks: TasksService,
    private current: CurrentProjectService,
    private auth: AuthService,
    private fs: Firestore,
    private tr: TranslateService,
    private dateAdapter: DateAdapter<Date>,
  ) {}

  // ===== ユーティリティ（Date <-> YYYY-MM-DD） =====
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

  // ===== 画面イベント（期間の疑似入力フォーム） =====
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

  // ===== 言語 → Datepicker ロケール同期 =====
  private applyLocaleFromI18n() {
    const l = (this.tr.currentLang || '').toLowerCase();
    this.dateAdapter.setLocale(l.startsWith('en') ? 'en-US' : 'ja-JP');
  }

  ngOnInit(): void {
    // 初期ロケール反映 & 言語切替に追随
    this.applyLocaleFromI18n();
    this.langSub = this.tr.onLangChange.subscribe(() => this.applyLocaleFromI18n());

    // 初期の文字列→Date（リロード時にも使える）
    this.displayStartDate = this.toDate(this.startRange);
    this.displayEndDate = this.toDate(this.endRange);

    this.members$ = safeFromProject$(
      this.current.projectId$,
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
    this.langSub?.unsubscribe();
  }

  // -------- UI handlers --------
  onViewModeChange(mode: 'list' | 'calendar') { this.viewMode = mode; }
  onOpenOnlyChange(v: boolean) { this.openOnly = v; this.reload(); }
  onTagQueryChange() { this.reload(); }
  onDateRangeChange() { this.reload(); }
  onMonthChange(date: Date) { this.calendarMonth = date; }
  trackTask = (_: number, task: Task) => task.id;
  isBusy(id?: string) { return !!id && this.inFlight.has(id); }

  // -------- Calendar helpers --------
  calendarTasks(vm: Vm): Task[] {
    return [
      ...vm.overdue, ...vm.today, ...vm.tomorrow,
      ...vm.thisWeekRest, ...vm.nextWeek, ...vm.later,
    ].filter(t => !!t.dueDate);
  }
  calendarUndated(vm: Vm): Task[] { return [...vm.nodue]; }

  // -------- Util --------
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

  private dedupeVm(vm: Vm): Vm {
    const order: (keyof Vm)[] = ['overdue','today','tomorrow','thisWeekRest','nextWeek','later','nodue'];
    const seen = new Set<string>();
    const out: any = {};
    for (const key of order) {
      out[key] = (vm[key] || []).filter(t => {
        if (!t?.id) return false;
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
    }
    return out as Vm;
  }


  // 追加: ISO日付(YYYY-MM-DD)を比較・クランプする小ユーティリティ
  private minIso(a: string, b: string) { return a <= b ? a : b; }
  private maxIso(a: string, b: string) { return a >= b ? a : b; }
  private validRange(from: string, to: string) { return from <= to; }

  // -------- Data load --------
  reload() {
    const FAR = '9999-12-31';
    const tags = this.parseTags(this.tagQuery);
    const params$ = this.midnightTick$.pipe(startWith(null));
  
    this.vm$ = combineLatest([this.current.projectId$, this.auth.uid$, params$]).pipe(
      switchMap(([pid, uid]) => {
        if (!pid || pid === 'default' || !uid) return of(EMPTY_VM);
  
        const today = new Date(); today.setHours(0,0,0,0);
        const tomorrow = this.addDays(today, 1);
  
        const dow = today.getDay();
        const diffToMon = (dow === 0 ? -6 : 1 - dow);
        const startOfWeek = this.addDays(today, diffToMon);
        const endOfWeek = this.addDays(startOfWeek, 6);
        const startOfNextWeek = this.addDays(endOfWeek, 1);
        const endOfNextWeek = this.addDays(startOfNextWeek, 6);
  
        const start = this.startRange || '0000-01-01';
        const end = this.endRange || FAR;
  
        // 文字列ISOで比較するので YYYY-MM-DD のままでOK
        const isoToday = this.ymd(today);
        const isoTomorrow = this.ymd(tomorrow);
        const isoThisWeekRestStart = this.ymd(this.addDays(tomorrow, 1));
        const isoEndOfWeek = this.ymd(endOfWeek);
        const isoStartOfNextWeek = this.ymd(startOfNextWeek);
        const isoEndOfNextWeek = this.ymd(endOfNextWeek);
        const isoAfterNextWeek = this.ymd(this.addDays(endOfNextWeek, 1));
  
        return safeFromProject$(
          this.current.projectId$,
          pid => {
            // 1) 今日まで（overdue/today用）
            const allToToday$ = this.tasks.listMine$(pid, uid, this.openOnly, start, this.minIso(end, isoToday), tags);
            const overdue$ = allToToday$.pipe(map(xs => xs.filter(x => (x.dueDate ?? '') < isoToday)));
            const today$   = allToToday$.pipe(map(xs => xs.filter(x => x.dueDate === isoToday)));
  
            // 2) 明日（終了日を超えるなら空に）
            const tomorrow$ =
              (isoTomorrow <= end)
                ? this.tasks.listMine$(pid, uid, this.openOnly, isoTomorrow, isoTomorrow, tags)
                : of([] as Task[]);
  
            // 3) 今週の残り（[明後日, 週末] を end でクランプ）
            const wRestEnd = this.minIso(isoEndOfWeek, end);
            const thisWeekRest$ =
              (this.validRange(isoThisWeekRestStart, wRestEnd))
                ? this.tasks.listMine$(pid, uid, this.openOnly, isoThisWeekRestStart, wRestEnd, tags)
                : of([] as Task[]);
  
            // 4) 来週（[来週月, 来週末] を end でクランプ。end が来週月より前なら空）
            const nextEnd = this.minIso(isoEndOfNextWeek, end);
            const nextWeek$ =
              (this.validRange(isoStartOfNextWeek, nextEnd))
                ? this.tasks.listMine$(pid, uid, this.openOnly, isoStartOfNextWeek, nextEnd, tags)
                : of([] as Task[]);
  
            // 5) 以降（[来週末の翌日, end]。end がそれより前なら空）
            const later$ =
              (this.validRange(isoAfterNextWeek, end))
                ? this.tasks.listMine$(pid, uid, this.openOnly, isoAfterNextWeek, end, tags)
                : of([] as Task[]);
  
            const nodue$ = this.tasks.listMineNoDue$(pid, uid, this.openOnly, tags);
  
            return combineLatest([overdue$, today$, tomorrow$, thisWeekRest$, nextWeek$, later$, nodue$]).pipe(
              map(([overdue, todayArr, tomorrowArr, thisWeekRest, nextWeek, later, nodue]) =>
                this.dedupeVm({ overdue, today: todayArr, tomorrow: tomorrowArr, thisWeekRest, nextWeek, later, nodue })
              ),
            );
          },
          EMPTY_VM
        );
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  // -------- Date ops --------
  onDueDateChange(event: { task: Task; dueDate: string | null }) {
    this.scheduleDueUpdate(event.task, event.dueDate);
  }

  private scheduleDueUpdate(task: Task, dueDate: string | null) {
    if (!task?.id || !task.projectId || !task.problemId || !task.issueId) return;
    const key = task.id;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);

    const prev = this.dueDateTimers.get(key);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(async () => {
      try {
        await this.tasks.update(task.projectId!, task.problemId!, task.issueId!, task.id!, { dueDate });
      } catch (err) {
        console.error(err);
      } finally {
        this.inFlight.delete(key);
        this.dueDateTimers.delete(key);
      }
    }, 400);
    this.dueDateTimers.set(key, timer);
  }

  // ---- 確認ダイアログ付きアクション ----
  async markDone(task: Task) {
    if (!task?.id || !task.projectId || !task.problemId || !task.issueId) return;
    const ok = this.confirmI18n('myTasks.confirm.markDone', { title: task.title });
    if (!ok) return;
    try {
      await this.tasks.update(task.projectId, task.problemId, task.issueId, task.id, { status: 'done' as any });
    } catch (err) {
      console.error(err);
    }
  }

  shiftTask(event: { task: Task; days: number }) {
    const { task, days } = event || {};
    if (!task?.id || !task.dueDate) return;
    if (this.inFlight.has(task.id)) return;

    const ok = this.confirmI18n('myTasks.confirm.shiftBy', { n: days });
    if (!ok) return;

    const current = new Date(task.dueDate);
    if (isNaN(current.getTime())) return;
    current.setDate(current.getDate() + days);
    const next = this.toYmd(current);
    this.scheduleDueUpdate(task, next);
  }

  setTaskToday(task: Task) {
    if (!task?.id) return;
    if (this.inFlight.has(task.id)) return;

    const ok = this.confirmI18n('myTasks.confirm.setToday');
    if (!ok) return;

    const today = new Date(); today.setHours(0,0,0,0);
    this.scheduleDueUpdate(task, this.toYmd(today));
  }

  private flattenVm(vm: Vm) {
    return [
      ...vm.overdue, ...vm.today, ...vm.tomorrow, ...vm.thisWeekRest,
      ...vm.nextWeek, ...vm.later, ...vm.nodue,
    ];
  }

  // -------- Export --------
  exportCurrent(kind: 'csv' | 'json') {
    this.vm$.pipe(take(1)).subscribe(async vm => {
      const data = this.flattenVm(vm);
      const nameMap = await this.resolveNames(data);
      const assigneeDir = await this.resolveAssigneeDirectory(data);
      if (kind === 'csv') {
        const csv = this.toCsv(data, nameMap, assigneeDir);
        const fname = this.tr.instant('myTasks.export.csvFileName') || 'my-tasks.csv';
        this.download(fname, csv, 'text/csv');
      } else {
        const json = this.toJson(data, nameMap, assigneeDir);
        const fname = this.tr.instant('myTasks.export.jsonFileName') || 'my-tasks.json';
        this.download(fname, json, 'application/json');
      }
    });
  }

  private toCsv(tasks: Task[], nameMap: Map<string, string>, dir: Map<string, string>): string {
    const headerKeys = ['id','title','status','priority','due','assignees','project','problem','issue','tags','progress','createdAt','updatedAt'];
    const headers = headerKeys.map(k => this.tr.instant(`schedule.export.headers.${k}`) || k);

    const esc = (v: any) => `"${(v ?? '').toString().replace(/"/g, '""')}"`;
    const fmtTs = (x: any) => {
      const d = x?.toDate?.() ?? (typeof x === 'string' ? new Date(x) : null);
      return d && !isNaN(d as any) ? new Date(d).toISOString().replace('T',' ').replace('Z','') : '';
    };
    const joinAssignees = (xs: any) =>
      Array.isArray(xs) ? xs.map((u: string) => dir.get(u) ?? u).join(', ') : (xs ?? '');

    const rows = tasks.map(t => {
      const pj = t.projectId ? (nameMap.get(`project:${t.projectId}`) ?? t.projectId) : '';
      const pr = (t.projectId && t.problemId) ? (nameMap.get(`problem:${t.projectId}:${t.problemId}`) ?? t.problemId) : '';
      const is = (t.projectId && t.problemId && t.issueId) ? (nameMap.get(`issue:${t.projectId}:${t.problemId}:${t.issueId}`) ?? t.issueId) : '';
      return [
        t.id, t.title, t.status, t.priority ?? '', t.dueDate ?? '',
        joinAssignees(t.assignees), pj, pr, is,
        Array.isArray(t.tags) ? t.tags.join(', ') : (t.tags ?? ''),
        (t as any).progress ?? '', fmtTs((t as any).createdAt), fmtTs((t as any).updatedAt),
      ].map(esc).join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  private toJson(tasks: Task[], nameMap: Map<string, string>, dir: Map<string, string>): string {
    const mapped = tasks.map(t => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority ?? null,
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

  // ---- File download helper ----
  private download(filename: string, content: string, mime = 'text/plain') {
    const bom = mime.startsWith('text/csv') ? '\uFEFF' : '';
    const blob = new Blob([bom + content], { type: mime + ';charset=utf-8' });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  // ---- Firestore name resolvers ----
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

  // ---- i18n confirm helper ----
  private confirmI18n(key: string, params?: Record<string, any>) {
    const msg = this.tr.instant(key, params);
    // 素直にブラウザ標準のconfirmを使用（Materialダイアログ未導入でもOK）
    return window.confirm(msg);
  }
}



