import { Component, inject } from '@angular/core';
import { AsyncPipe, DecimalPipe, NgFor, NgIf } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatDividerModule } from '@angular/material/divider';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { doc, Firestore } from '@angular/fire/firestore';
import { docData as rxDocData } from 'rxfire/firestore';
import { doc as nativeDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from '@angular/fire/functions';
import { firstValueFrom, map, Observable, of, switchMap, combineLatest } from 'rxjs';
import { safeFromProject$ } from '../utils/rx-safe';

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

/** ← モックは廃止。空状態はこの定数で表現します。 */
const EMPTY_SUMMARY: AnalyticsSummary = {
  completedTasks7d: 0,
  avgLeadTime30dDays: 0,
  lateRateThisWeekPercent: 0,
  statusBreakdown: [],
  problemProgress: [],
};

const EMPTY_MY: PersonalAnalyticsSummary = {
  completedTasks7d: 0,
  avgLeadTime30dDays: 0,
  lateRateThisWeekPercent: 0,
  statusBreakdown: [],
};

/** 受け取った Firestore 値を安全に整形（欠損・型違いを吸収） */
function toNum(n: any, d = 0): number {
  return Number.isFinite(n) ? Number(n) : d;
}
type StatusItem = { label: string; count: number };
type ProgItem   = { title: string; percent: number };

function coerceSummary(data: any): AnalyticsSummary {
  const status = Array.isArray(data?.statusBreakdown) ? data.statusBreakdown : [];
  const prog   = Array.isArray(data?.problemProgress) ? data.problemProgress : [];

  const statusArr: StatusItem[] = (status as any[])
    .map((e: any): StatusItem => ({ label: String(e?.label ?? ''), count: toNum(e?.count) }))
    .filter((e: StatusItem) => e.label !== '');

  const progArr: ProgItem[] = (prog as any[])
    .map((p: any): ProgItem => ({ title: String(p?.title ?? ''), percent: toNum(p?.percent) }))
    .filter((p: ProgItem) => p.title !== '');

  return {
    completedTasks7d: toNum(data?.completedTasks7d),
    avgLeadTime30dDays: toNum(data?.avgLeadTime30dDays),
    lateRateThisWeekPercent: toNum(data?.lateRateThisWeekPercent),
    statusBreakdown: statusArr,
    problemProgress: progArr,
  };
}

function coerceMySummary(data: any): PersonalAnalyticsSummary {
  const status = Array.isArray(data?.statusBreakdown) ? data.statusBreakdown : [];

  const statusArr: StatusItem[] = (status as any[])
    .map((e: any): StatusItem => ({ label: String(e?.label ?? ''), count: toNum(e?.count) }))
    .filter((e: StatusItem) => e.label !== '');

  return {
    completedTasks7d: toNum(data?.completedTasks7d),
    avgLeadTime30dDays: toNum(data?.avgLeadTime30dDays),
    lateRateThisWeekPercent: toNum(data?.lateRateThisWeekPercent),
    statusBreakdown: statusArr,
  };
}

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
  private readonly i18n = inject(TranslateService);

  readonly projectId$: Observable<string | null> = this.currentProject.projectId$;

  readonly projectName$: Observable<string | null> = safeFromProject$(
    this.currentProject.projectId$,
    pid => {
      const ref = nativeDoc(this.firestore as any, `projects/${pid}`);
      return rxDocData(ref).pipe(
        map((d: any) => (d?.meta?.name ?? d?.name ?? null) as string | null)
      );
    },
    null
  );

  /** プロジェクト全体サマリー（モックなし、空は EMPTY_*） */
  readonly summary$: Observable<AnalyticsSummary> = safeFromProject$(
    this.currentProject.projectId$,
    pid => {
      const summaryRef = nativeDoc(this.firestore as any, `projects/${pid}/analytics/currentSummary`);
      return rxDocData(summaryRef).pipe(
        map(data => (data ? coerceSummary(data) : EMPTY_SUMMARY))
      );
    },
    EMPTY_SUMMARY
  );

  readonly statusEntries$ = this.summary$.pipe(
    map(summary => {
      const total = summary.statusBreakdown.reduce((acc, e) => acc + e.count, 0) || 1;
      return summary.statusBreakdown.map(e => ({ ...e, percent: (e.count / total) * 100 }));
    }),
  );

  /** ログインユーザー専用サマリー（モックなし） */
  readonly mySummary$: Observable<PersonalAnalyticsSummary> = combineLatest([
    this.currentProject.projectId$,
    this.auth.uid$,
  ]).pipe(
    switchMap(([projectId, uid]) => {
      if (!projectId || !uid) return of(EMPTY_MY);
      return safeFromProject$(
        this.currentProject.projectId$,
        pid => {
          const ref = nativeDoc(this.firestore as any, `projects/${pid}/analyticsPerUser/${uid}`);
          return rxDocData(ref).pipe(
            map(data => (data ? coerceMySummary(data) : EMPTY_MY))
          );
        },
        EMPTY_MY
      );
    })
  );

  readonly myStatusEntries$ = this.mySummary$.pipe(
    map(summary => {
      const total = summary.statusBreakdown.reduce((acc, e) => acc + e.count, 0) || 1;
      return summary.statusBreakdown.map(e => ({ ...e, percent: (e.count / total) * 100 }));
    }),
  );

  async onRefreshAnalytics(): Promise<void> {
    const [projectId, projectName] = await Promise.all([
      firstValueFrom(this.projectId$),
      firstValueFrom(this.projectName$),
    ]);

    if (!projectId) {
      console.warn('[analytics] Cannot refresh analytics summary without a projectId');
      return;
    }

    const name = projectName || projectId;
    const ok = window.confirm(this.i18n.instant('analytics.confirm.refresh', { name }));
    if (!ok) return;

    const functions = getFunctions(undefined, 'asia-northeast1');
    const callable = httpsCallable<{ projectId: string }, { ok: boolean }>(functions, 'refreshAnalyticsSummaryV2');
    try {
      await callable({ projectId });
      alert(this.i18n.instant('analytics.refresh.ok'));
      console.log('[analytics] manual refresh OK');
    } catch (err) {
      console.error('[analytics] manual refresh failed', err);
      alert(this.i18n.instant('analytics.refresh.fail'));
    }
  }
}

