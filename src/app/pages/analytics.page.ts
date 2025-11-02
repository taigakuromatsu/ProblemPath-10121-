import { Component, inject } from '@angular/core';
import { AsyncPipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatDividerModule } from '@angular/material/divider';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { doc, docData, Firestore } from '@angular/fire/firestore';
import { getFunctions, httpsCallable } from '@angular/fire/functions';
import { catchError, firstValueFrom, map, Observable, of, switchMap, combineLatest } from 'rxjs';

import { CurrentProjectService } from '../services/current-project.service';
import { AuthService } from '../services/auth.service';

export interface AnalyticsSummary {
  completedTasks7d: number;
  avgLeadTime30dDays: number;
  lateRateThisWeekPercent: number;
  statusBreakdown: { label: string; count: number }[];
  problemProgress: { title: string; percent: number }[];
}

export interface PersonalAnalyticsSummary {
  completedTasks7d: number;
  avgLeadTime30dDays: number;
  lateRateThisWeekPercent: number;
  statusBreakdown: { label: string; count: number }[];
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

const MOCK_MY: PersonalAnalyticsSummary = {
  completedTasks7d: 0,
  avgLeadTime30dDays: 0,
  lateRateThisWeekPercent: 0,
  statusBreakdown: [],
};

@Component({
  standalone: true,
  selector: 'pp-analytics-page',
  templateUrl: './analytics.page.html',
  styleUrls: ['./analytics.page.scss'],
  imports: [
    AsyncPipe, NgFor, NgIf, DecimalPipe,
    MatCardModule, MatIconModule, MatDividerModule, MatProgressBarModule,
    MatButtonModule, MatTooltipModule, TranslateModule,
  ],
})
export class AnalyticsPage {
  private readonly currentProject = inject(CurrentProjectService);
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);

  readonly projectId$: Observable<string | null> = this.currentProject.projectId$;

  // プロジェクト全体サマリー（既存）
  readonly summary$: Observable<AnalyticsSummary> = this.projectId$.pipe(
    switchMap(projectId => {
      if (!projectId) return of(MOCK_SUMMARY);
      const summaryRef = doc(this.firestore, `projects/${projectId}/analytics/currentSummary`);
      return docData(summaryRef).pipe(
        map((data): AnalyticsSummary => (data as AnalyticsSummary) ?? MOCK_SUMMARY),
        catchError(() => of(MOCK_SUMMARY)),
      );
    }),
  );

  readonly statusEntries$ = this.summary$.pipe(
    map(summary => {
      const total = summary.statusBreakdown.reduce((acc, e) => acc + e.count, 0) || 1;
      return summary.statusBreakdown.map(e => ({ ...e, percent: (e.count / total) * 100 }));
    }),
  );

  // 追加: ログインユーザー専用サマリー
  readonly mySummary$: Observable<PersonalAnalyticsSummary> = combineLatest([
    this.projectId$,
    this.auth.uid$,
  ]).pipe(
    switchMap(([projectId, uid]) => {
      if (!projectId || !uid) return of(MOCK_MY);
      const ref = doc(this.firestore, `projects/${projectId}/analyticsPerUser/${uid}`);
      return docData(ref).pipe(
        map((data): PersonalAnalyticsSummary => (data as PersonalAnalyticsSummary) ?? MOCK_MY),
        catchError(() => of(MOCK_MY)),
      );
    }),
  );

  readonly myStatusEntries$ = this.mySummary$.pipe(
    map(summary => {
      const total = summary.statusBreakdown.reduce((acc, e) => acc + e.count, 0) || 1;
      return summary.statusBreakdown.map(e => ({ ...e, percent: (e.count / total) * 100 }));
    }),
  );

  async onRefreshAnalytics(): Promise<void> {
    console.log('[analytics] TEST LOG onRefreshAnalytics() start');
    const projectId = await firstValueFrom(this.projectId$);
    console.log('[analytics] projectId =', projectId);
    if (!projectId) {
      console.warn('[analytics] Cannot refresh analytics summary without a projectId');
      return;
    }
    const functions = getFunctions(undefined, 'asia-northeast1');
    const callable = httpsCallable<{ projectId: string }, { ok: boolean }>(functions, 'refreshAnalyticsSummaryV2');
    try {
      await callable({ projectId });
      console.log('[analytics] manual refresh OK');
    } catch (err) {
      console.error('[analytics] manual refresh failed', err);
    }
  }
}
