// src/app/components/task-calendar/task-calendar.component.ts
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { Task } from '../../models/types';

interface CalendarDay {
  date: Date;
  iso: string;
  inCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  tasks: Task[];
  overdue: boolean;
  dueSoon: boolean;
}

interface CalendarWeek {
  days: CalendarDay[];
}

@Component({
  selector: 'pp-task-calendar',
  standalone: true,
  imports: [CommonModule, DragDropModule, MatIconModule, MatButtonModule, MatTooltipModule, TranslateModule],
  templateUrl: './task-calendar.component.html',
  styleUrls: ['./task-calendar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskCalendarComponent implements OnChanges, OnInit, OnDestroy {
  @Input() tasks: Task[] = [];
  @Input() undatedTasks: Task[] = [];
  @Input() activeMonth = new Date();
  @Input() memberDirectory: Record<string, string> | null = null;

  @Output() monthChange = new EventEmitter<Date>();
  @Output() dueDateChange = new EventEmitter<{ task: Task; dueDate: string | null }>();

  weeks: CalendarWeek[] = [];
  dropListIds: string[] = [];

  /** 翻訳キー（表示はテンプレートで |translate） */
  readonly weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  private langSub?: Subscription;

  constructor(private tr: TranslateService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    // 言語切替時に再描画（OnPushのため手動でCDをキック）
    this.langSub = this.tr.onLangChange.subscribe(() => this.cdr.markForCheck());
  }

  ngOnDestroy(): void {
    this.langSub?.unsubscribe();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['tasks'] || changes['activeMonth'] || changes['undatedTasks']) {
      this.buildCalendar();
    }
  }

  trackTask = (_: number, item: Task) => item.id;

  get monthLabel(): string {
    const locale = this.localeFromTranslate(this.tr.currentLang);
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(this.activeMonth);
  }

  private localeFromTranslate(lang?: string): string {
    const l = (lang || '').toLowerCase();
    if (l.startsWith('ja')) return 'ja-JP';
    if (l.startsWith('en')) return 'en';
    // 必要に応じてロケールを追加
    return 'en';
  }

  previousMonth() {
    const d = new Date(this.activeMonth);
    d.setMonth(d.getMonth() - 1);
    this.monthChange.emit(d);
  }

  nextMonth() {
    const d = new Date(this.activeMonth);
    d.setMonth(d.getMonth() + 1);
    this.monthChange.emit(d);
  }

  onDrop(event: CdkDragDrop<Task[]>, iso: string | null) {
    if (event.previousContainer === event.container) {
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
      return;
    }
    transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex);
    const task = event.item.data as Task;
    const dueDate = iso;
    this.dueDateChange.emit({ task, dueDate });
  }

  onDropToNoDue(event: CdkDragDrop<Task[]>) {
    if (event.previousContainer === event.container) {
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
      return;
    }
    transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex);
    const task = event.item.data as Task;
    this.dueDateChange.emit({ task, dueDate: null });
  }

  statusColor(status: string | undefined): string {
    switch (status) {
      case 'done':
        return '#16a34a';
      case 'in_progress':
        return '#2563eb';
      default:
        return '#dc2626';
    }
  }

  tooltip(day: CalendarDay): string {
    if (!day.tasks.length) return '';
    return day.tasks.map(t => t.title).join('\n');
  }

  private buildCalendar() {
    const monthStart = new Date(this.activeMonth.getFullYear(), this.activeMonth.getMonth(), 1);
    const firstDay = this.startOfWeek(monthStart);
    const monthEnd = new Date(this.activeMonth.getFullYear(), this.activeMonth.getMonth() + 1, 0);
    const lastDay = this.endOfWeek(monthEnd);
    const map = new Map<string, Task[]>();
    for (const task of this.tasks ?? []) {
      if (!task.dueDate) continue;
      if (!map.has(task.dueDate)) map.set(task.dueDate, []);
      map.get(task.dueDate)!.push(task);
    }

    const weeks: CalendarWeek[] = [];
    const dropIds: string[] = [];
    const iter = new Date(firstDay);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    while (iter <= lastDay) {
      const week: CalendarDay[] = [];
      for (let i = 0; i < 7; i++) {
        const iso = this.ymd(iter);
        const tasks = [...(map.get(iso) ?? [])];
        const isToday = iter.getTime() === today.getTime();
        const overdue = tasks.some(t => this.isBeforeToday(t.dueDate));
        const dueSoon = tasks.some(t => this.isSoon(t.dueDate));
        week.push({
          date: new Date(iter),
          iso,
          inCurrentMonth: iter.getMonth() === this.activeMonth.getMonth(),
          isToday,
          isWeekend: iter.getDay() === 0 || iter.getDay() === 6,
          tasks,
          overdue,
          dueSoon,
        });
        dropIds.push(this.dropListId(iso));
        iter.setDate(iter.getDate() + 1);
      }
      weeks.push({ days: week });
    }

    this.weeks = weeks;
    this.dropListIds = [...new Set([...dropIds, this.dropListId('no-due')])];
  }

  private dropListId(iso: string): string {
    return `calendar-${iso}`;
  }

  dropIdForDay(day: CalendarDay): string {
    return this.dropListId(day.iso);
  }

  dropIdForNoDue(): string {
    return this.dropListId('no-due');
  }

  private ymd(date: Date): string {
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, '0');
    const d = `${date.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private startOfWeek(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private endOfWeek(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? 0 : 7 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private isBeforeToday(iso: string | null | undefined): boolean {
    if (!iso) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(iso);
    if (isNaN(due.getTime())) return false;
    return due.getTime() < today.getTime();
  }

  private isSoon(iso: string | null | undefined): boolean {
    if (!iso) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(iso);
    if (isNaN(due.getTime())) return false;
    const diff = Math.floor((due.getTime() - today.getTime()) / 86400000);
    return diff >= 0 && diff <= 2;
  }
}




