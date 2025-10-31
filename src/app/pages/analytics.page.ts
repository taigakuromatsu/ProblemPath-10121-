import { Component, inject } from '@angular/core';
import { AsyncPipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatDividerModule } from '@angular/material/divider';
import { TranslateModule } from '@ngx-translate/core';
import { doc, docData, Firestore } from '@angular/fire/firestore';
import { catchError, map, Observable, of, switchMap } from 'rxjs';

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
  private readonly firestore = inject(Firestore);

  readonly projectId$: Observable<string | null> = this.currentProject.projectId$;

  readonly summary$: Observable<AnalyticsSummary> = this.projectId$.pipe(
    switchMap(projectId => {
      if (!projectId) {
        return of(MOCK_SUMMARY);
      }
      const summaryRef = doc(
        this.firestore,
        `projects/${projectId}/analytics/currentSummary`,
      );
      // TODO: このドキュメントはCloud Functions側で集計して定期更新する予定（7日間完了数・30日平均リードタイム・今週の遅延率など）
      return docData<AnalyticsSummary>(summaryRef).pipe(
        catchError(() => of(MOCK_SUMMARY)),
      );
    }),
    map(summary => summary ?? MOCK_SUMMARY),
  );

  readonly statusEntries$ = this.summary$.pipe(
    map(summary => {
      const total = summary.statusBreakdown.reduce((acc, entry) => acc + entry.count, 0) || 1;
      return summary.statusBreakdown.map(entry => ({
        ...entry,
        percent: (entry.count / total) * 100,
      }));
    }),
  );
}
