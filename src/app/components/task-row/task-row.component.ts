import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';
import { Task } from '../../models/types';
import { input } from '@angular/core';

export interface TaskRowActionConfig {
  showComplete?: boolean;
  showShiftTomorrow?: boolean;
  showSetToday?: boolean;
}

@Component({
  selector: 'pp-task-row',
  standalone: true,
  imports: [CommonModule, RouterLink, MatIconModule, MatTooltipModule, MatButtonModule, TranslateModule],
  templateUrl: './task-row.component.html',
  styleUrls: ['./task-row.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskRowComponent {
  @Input() task!: Task;
  @Input() memberDirectory: Record<string, string> | null = null;
  @Input() actionConfig: TaskRowActionConfig = { showComplete: true, showShiftTomorrow: true, showSetToday: true };
  @Input() dense = false;

  @Output() complete = new EventEmitter<Task>();
  @Output() shiftDays = new EventEmitter<{ task: Task; days: number }>();
  @Output() setToday = new EventEmitter<Task>();

  @Input() actions: { complete?: boolean; shift?: boolean; setToday?: boolean } = {
    complete: true,
    shift: true,
    setToday: true,
  };

  @Input() busy = false;

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

  assigneeLabel(uid: string): string {
    if (!this.memberDirectory) return uid;
    return this.memberDirectory[uid] ?? uid;
  }

  assignees(task: Task): string {
    const ids = task.assignees ?? [];
    if (!ids.length) {
      return '-';
    }
    return ids.map(id => this.assigneeLabel(id)).join(', ');
  }

  tagsCount(task: Task): number {
    return (task.tags ?? []).length;
  }

  commentCount(task: Task): number {
    const anyTask = task as any;
    return anyTask?.commentCount ?? anyTask?.commentsCount ?? 0;
  }

  attachmentCount(task: Task): number {
    const anyTask = task as any;
    return anyTask?.attachmentCount ?? anyTask?.attachmentsCount ?? 0;
  }

  dueBadge(task: Task): 'overdue' | 'today' | 'soon' | 'later' | 'none' {
    if (!task.dueDate) return 'none';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(task.dueDate);
    if (isNaN(due.getTime())) return 'none';
    const diff = Math.floor((due.getTime() - today.getTime()) / 86400000);
    if (diff < 0) return 'overdue';
    if (diff === 0) return 'today';
    if (diff <= 2) return 'soon';
    return 'later';
  }

  dueLabel(task: Task): string {
    if (!task.dueDate) return '-';
    const date = new Date(task.dueDate);
    if (isNaN(date.getTime())) return task.dueDate;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  onComplete() {
    this.complete.emit(this.task);
  }

  onShift(days: number) {
    this.shiftDays.emit({ task: this.task, days });
  }

  onSetToday() {
    this.setToday.emit(this.task);
  }
}
