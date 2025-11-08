// src/app/components/task-row/task-row.component.ts
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { Task } from '../../models/types';
import { OnChanges, SimpleChanges } from '@angular/core';
import { CommentsService, CommentTarget } from '../../services/comments.service';
import { AttachmentsService, AttachmentTarget } from '../../services/attachments.service';

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
export class TaskRowComponent implements OnDestroy, OnChanges {
  @Input() task!: Task;
  @Input() memberDirectory: Record<string, string> | null = null;
  @Input() actionConfig: TaskRowActionConfig = { showComplete: true, showShiftTomorrow: true, showSetToday: true };
  @Input() dense = false;

  @Output() complete = new EventEmitter<Task>();
  @Output() shiftDays = new EventEmitter<{ task: Task; days: number }>();
  @Output() setToday = new EventEmitter<Task>();

  /** schedule.page から渡される簡易フラグ群（こちらを優先） */
  @Input() actions: { complete?: boolean; shift?: boolean; setToday?: boolean } = {
    complete: true,
    shift: true,
    setToday: true,
  };

  @Input() busy = false;

  @Input() useLiveCountsIfMissing = false;

  private liveCommentCount: number | null = null;
  private liveAttachmentCount: number | null = null;
  private commentsSub?: Subscription;
  private attachmentsSub?: Subscription;

  /** 現在のロケール（言語切替で更新） */
  private locale: string;
  private langSub: Subscription;

  constructor(
    private tr: TranslateService, 
    private cdr: ChangeDetectorRef,
    private comments: CommentsService,
    private attachments: AttachmentsService,
  ) {
    // 初期ロケール設定
    this.locale = this.resolveLocaleFromI18n(this.tr.currentLang);
    // 言語切替に追随してロケール変更 → OnPush再描画
    this.langSub = this.tr.onLangChange.subscribe(ev => {
      this.locale = this.resolveLocaleFromI18n(ev.lang);
      this.cdr.markForCheck();
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if ('task' in changes || 'useLiveCountsIfMissing' in changes) {
      this.setupLiveCountSubscriptions();
    }
  }
  
  ngOnDestroy(): void {
    this.langSub?.unsubscribe();
    this.commentsSub?.unsubscribe();
    this.attachmentsSub?.unsubscribe();
  }

  private setupLiveCountSubscriptions() {
    // 一旦クリア
    this.commentsSub?.unsubscribe();
    this.attachmentsSub?.unsubscribe();
    this.liveCommentCount = null;
    this.liveAttachmentCount = null;

    if (!this.useLiveCountsIfMissing || !this.task) return;

    const anyTask = this.task as any;

    // すでに集計フィールドがある場合はそれを優先し、追加クエリは投げない
    const hasAggregated =
      typeof anyTask?.commentCount === 'number' ||
      typeof anyTask?.commentsCount === 'number' ||
      typeof anyTask?.attachmentCount === 'number' ||
      typeof anyTask?.attachmentsCount === 'number';

    if (hasAggregated) return;

    // タスクのパス情報が揃っていない場合はライブ集計不可
    if (!this.task.projectId || !this.task.problemId || !this.task.issueId || !this.task.id) return;

    const commentTarget: CommentTarget = {
      kind: 'task',
      projectId: this.task.projectId,
      problemId: this.task.problemId,
      issueId: this.task.issueId,
      taskId: this.task.id,
    };

    this.commentsSub = this.comments
      .listByTarget$(commentTarget, 1000)
      .subscribe(list => {
        this.liveCommentCount = list.length;
        this.cdr.markForCheck();
      });

    const attachmentTarget: AttachmentTarget = {
      kind: 'task',
      projectId: this.task.projectId,
      problemId: this.task.problemId,
      issueId: this.task.issueId,
      taskId: this.task.id,
    };

    this.attachmentsSub = this.attachments
      .list(attachmentTarget)
      .subscribe(list => {
        this.liveAttachmentCount = list.length;
        this.cdr.markForCheck();
      });
  }


  private resolveLocaleFromI18n(lang?: string): string {
    const l = (lang || '').toLowerCase();
    if (l.startsWith('en')) return 'en-US';
    if (l.startsWith('ja')) return 'ja-JP';
    if (l.startsWith('zh')) return 'zh-CN';
    // 既定は英語
    return 'en-US';
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

  assigneeLabel(uid: string): string {
    if (!this.memberDirectory) return uid;
    return this.memberDirectory[uid] ?? uid;
  }

  assignees(task: Task): string {
    const ids = task.assignees ?? [];
    if (!ids.length) {
      return this.tr.instant('common.none');
    }
    return ids.map(id => this.assigneeLabel(id)).join(', ');
  }

  tagsCount(task: Task): number {
    return (task.tags ?? []).length;
  }

  commentCount(task: Task): number {
    const anyTask = task as any;
    if (typeof anyTask?.commentCount === 'number') return anyTask.commentCount;
    if (typeof anyTask?.commentsCount === 'number') return anyTask.commentsCount;
    if (typeof this.liveCommentCount === 'number') return this.liveCommentCount;
    return 0;
  }

  attachmentCount(task: Task): number {
    const anyTask = task as any;
    if (typeof anyTask?.attachmentCount === 'number') return anyTask.attachmentCount;
    if (typeof anyTask?.attachmentsCount === 'number') return anyTask.attachmentsCount;
    if (typeof this.liveAttachmentCount === 'number') return this.liveAttachmentCount;
    return 0;
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

  /** 期日表示（i18nロケール準拠） */
  dueLabel(task: Task): string {
    if (!task.dueDate) return this.tr.instant('schedule.none');
    const date = new Date(task.dueDate);
    if (isNaN(date.getTime())) return task.dueDate!;
    // 言語に応じて 'Nov 1' / '11月1日' などを表示
    return new Intl.DateTimeFormat(this.locale, { month: 'short', day: 'numeric' }).format(date);
  }

  priorityLabel(task: Task): string | null {
    const p: any = (task as any)?.priority;
    if (!p) return null;
    // 'high' | 'mid' | 'low'
    return this.tr.instant(`priority.${p}`);
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


