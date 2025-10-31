import { Component, inject } from '@angular/core';
import { AsyncPipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatDividerModule } from '@angular/material/divider';
import { TranslateModule } from '@ngx-translate/core';
import { Observable } from 'rxjs';

import { CurrentProjectService } from '../services/current-project.service';

export interface AnalyticsSummary {
  completedTasks7d: number;
  avgLeadTime30dDays: number;
  lateRateThisWeekPercent: number;
  statusBreakdown: { label: string; count: number }[];
  problemProgress: { title: string; percent: number }[];
}

const MOCK_SUMMARY: AnalyticsSummary = {
  completedTasks7d: 42,
  avgLeadTime30dDays: 3.6,
  lateRateThisWeekPercent: 18.2,
  statusBreakdown: [
    { label: 'analytics.statusBreakdown.todo', count: 18 },
    { label: 'analytics.statusBreakdown.inProgress', count: 12 },
    { label: 'analytics.statusBreakdown.review', count: 6 },
    { label: 'analytics.statusBreakdown.done', count: 64 },
  ],
  problemProgress: [
    { title: 'オンボーディング改善', percent: 72 },
    { title: 'モバイルUIリファイン', percent: 55 },
    { title: '決済フロー安定化', percent: 88 },
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
    MatCardModule,
    MatIconModule,
    MatDividerModule,
    MatProgressBarModule,
    TranslateModule,
  ],
})
export class AnalyticsPage {
  private readonly currentProject = inject(CurrentProjectService);
  readonly projectId$: Observable<string | null> = this.currentProject.projectId$;
  // TODO: Firestore projects/{projectId}/analytics/currentSummary を購読して置き換える予定
  readonly summary = MOCK_SUMMARY;
  private readonly statusTotal = this.summary.statusBreakdown.reduce(
    (acc, entry) => acc + entry.count,
    0,
  ) || 1;
  readonly statusEntries: Array<{ label: string; count: number; percent: number }> = this.summary.statusBreakdown.map(entry => ({
    ...entry,
    percent: (entry.count / this.statusTotal) * 100,
  }));
  readonly problemProgress = this.summary.problemProgress;
}
