import { Component } from '@angular/core';
import { AsyncPipe, DecimalPipe, NgFor, NgIf, PercentPipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatDividerModule } from '@angular/material/divider';
import { TranslateModule } from '@ngx-translate/core';
import { Observable } from 'rxjs';

import { CurrentProjectService } from '../services/current-project.service';

interface ProblemProgressItem {
  problemId: string;
  problemTitle: string;
  progressPercent: number;
}

type StatusKey = 'todo' | 'inProgress' | 'review' | 'done';

interface AnalyticsSummary {
  completedTasks7d: number;
  avgLeadTime30d: number;
  lateRateThisWeek: number;
  statusBreakdown: Record<StatusKey, number>;
  problemProgress: ProblemProgressItem[];
}

interface StatusEntry {
  key: StatusKey;
  labelKey: string;
  count: number;
  percent: number;
}

const MOCK_ANALYTICS_SUMMARY: AnalyticsSummary = {
  completedTasks7d: 42,
  avgLeadTime30d: 3.6,
  lateRateThisWeek: 0.18,
  statusBreakdown: {
    todo: 18,
    inProgress: 12,
    review: 6,
    done: 64,
  },
  problemProgress: [
    { problemId: 'prob-1', problemTitle: 'オンボーディング改善', progressPercent: 72 },
    { problemId: 'prob-2', problemTitle: 'モバイルUIリファイン', progressPercent: 55 },
    { problemId: 'prob-3', problemTitle: '決済フロー安定化', progressPercent: 88 },
  ],
};

@Component({
  standalone: true,
  selector: 'pp-analytics-page',
  templateUrl: './analytics.page.html',
  styleUrls: ['./analytics.page.scss'],
  imports: [
    AsyncPipe,
    NgFor,
    NgIf,
    DecimalPipe,
    PercentPipe,
    MatCardModule,
    MatIconModule,
    MatDividerModule,
    MatProgressBarModule,
    TranslateModule,
  ],
})
export class AnalyticsPage {
  readonly projectId$: Observable<string | null>;
  // TODO: Replace mock summary with Firestore aggregation stream when available.
  readonly summary = MOCK_ANALYTICS_SUMMARY;
  readonly statusEntries: StatusEntry[] = this.buildStatusEntries(this.summary.statusBreakdown);
  readonly problemProgress = this.summary.problemProgress;

  constructor(private readonly currentProject: CurrentProjectService) {
    this.projectId$ = this.currentProject.projectId$;
  }

  private buildStatusEntries(status: AnalyticsSummary['statusBreakdown']): StatusEntry[] {
    const base: Array<{ key: StatusKey; labelKey: string }> = [
      { key: 'todo', labelKey: 'analytics.statusBreakdown.todo' },
      { key: 'inProgress', labelKey: 'analytics.statusBreakdown.inProgress' },
      { key: 'review', labelKey: 'analytics.statusBreakdown.review' },
      { key: 'done', labelKey: 'analytics.statusBreakdown.done' },
    ];
    const total = base.reduce((acc, item) => acc + (status[item.key] || 0), 0) || 1;
    return base.map(item => {
      const count = status[item.key] || 0;
      return {
        key: item.key,
        labelKey: item.labelKey,
        count,
        percent: (count / total) * 100,
      } satisfies StatusEntry;
    });
  }
}
