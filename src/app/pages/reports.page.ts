import { Component, DestroyRef, inject } from '@angular/core';
import { AsyncPipe, DatePipe, NgFor, NgIf } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDividerModule } from '@angular/material/divider';
import { TranslateModule } from '@ngx-translate/core';
import {
  addDoc,
  collection,
  collectionData,
  Firestore,
  Timestamp,
  serverTimestamp,
} from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, catchError, combineLatest, map, Observable, of, switchMap, take } from 'rxjs';

import { CurrentProjectService } from '../services/current-project.service';

export interface ReportMetrics {
  completedTasks: number;
  avgProgressPercent: number;
  notes: string;
}

export interface ReportEntry {
  id: string;
  title: string;
  createdAt: Timestamp | string;
  body: string;
  metrics: ReportMetrics;
}

interface DraftReport {
  title: string;
  body: string;
}

const MOCK_REPORTS: ReportEntry[] = [
  {
    id: 'rpt-20240407',
    title: '2024-W14 Progress',
    createdAt: '2024-04-07T09:00:00+09:00',
    body:
      '今週はUI改善関連のタスクが中心。ユーザーからのフィードバックを受けたナビゲーション調整が完了し、モバイル向けの最適化も進捗。',
    metrics: {
      completedTasks: 5,
      avgProgressPercent: 84,
      notes: 'UI改善を重点対応',
    },
  },
  {
    id: 'rpt-20240331',
    title: '2024-W13 Check-in',
    createdAt: '2024-03-31T09:00:00+09:00',
    body:
      'ヒアリング結果を分析し、今後の改善テーマを整理。バックエンド側の安定化タスクは進行中で、来週も継続。',
    metrics: {
      completedTasks: 3,
      avgProgressPercent: 76,
      notes: '課題ヒアリング継続',
    },
  },
];

@Component({
  standalone: true,
  selector: 'pp-reports-page',
  templateUrl: './reports.page.html',
  styleUrls: ['./reports.page.scss'],
  imports: [
    AsyncPipe,
    DatePipe,
    NgFor,
    NgIf,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatListModule,
    MatFormFieldModule,
    MatInputModule,
    MatDividerModule,
    TranslateModule,
  ],
})
export class ReportsPage {
  private readonly currentProject = inject(CurrentProjectService);
  private readonly firestore = inject(Firestore);
  private readonly functions = inject(Functions);
  private readonly destroyRef = inject(DestroyRef);

  readonly projectId$: Observable<string | null> = this.currentProject.projectId$;

  private readonly manualReportsSubject = new BehaviorSubject<ReportEntry[]>([]);
  private readonly manualReports$ = this.manualReportsSubject.asObservable();

  private readonly firestoreReports$: Observable<ReportEntry[]> = this.projectId$.pipe(
    switchMap(projectId => {
      if (!projectId) {
        return of(MOCK_REPORTS);
      }
      const reportsRef = collection(
        this.firestore,
        `projects/${projectId}/reports`,
      );
      // TODO: Cloud Functions + Geminiで自動生成した週次サマリをここにaddDocする予定
      return collectionData(reportsRef, { idField: 'id' }).pipe(
        map((entries): ReportEntry[] => (entries as ReportEntry[]).length ? (entries as ReportEntry[]) : MOCK_REPORTS),
        catchError(() => of(MOCK_REPORTS)),
      );
    }),
  );

  readonly reports$: Observable<ReportEntry[]> = combineLatest([
    this.firestoreReports$,
    this.manualReports$,
  ]).pipe(
    map(([remoteReports, manualReports]) => [...manualReports, ...remoteReports]),
  );

  activeReport: ReportEntry | null = null;
  manualFormOpen = false;
  draftReport: DraftReport = { title: '', body: '' };

  constructor() {
    this.reports$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(reports => {
        if (!reports.length) {
          this.activeReport = null;
          return;
        }
        if (this.activeReport) {
          const current = reports.find(report => report.id === this.activeReport?.id);
          if (current) {
            this.activeReport = current;
            return;
          }
        }
        this.activeReport = reports[0];
      });
  }

  generateDraft(): void {
    this.projectId$.pipe(take(1)).subscribe(projectId => {
      // TODO: role check (viewerは不可)
      if (!projectId) {
        console.warn('generateDraft: projectId is not available');
        return;
      }

      const callable = httpsCallable<
        { projectId: string },
        {
          title: string;
          body: string;
          metrics: { completedTasks: number; avgProgressPercent: number; notes: string };
        }
      >(this.functions, 'generateProgressReportDraft');

      callable({ projectId })
        .then(result => {
          const data = result.data;
          const now = new Date();
          this.activeReport = {
            id: `draft-${now.getTime()}`,
            title: data.title,
            createdAt: now.toISOString(),
            body: data.body,
            metrics: data.metrics,
          };
          // TODO: この草案はまだFirestoreに保存されていない一時データ。
          //       「保存」ボタンで projects/{projectId}/reports に書き込む予定。
          //       viewerロールは保存不可にする予定。
        })
        .catch(error => {
          console.warn('Failed to generate report draft', error);
        });
    });
  }

  addManualReport(): void {
    // TODO: 手動レポート追加時に Firestore 下書きドキュメントを生成する
    this.manualFormOpen = true;
    this.draftReport = { title: '', body: '' };
  }

  cancelManualReport(): void {
    this.manualFormOpen = false;
    this.draftReport = { title: '', body: '' };
  }

  saveReport(target: 'manual' | 'active' = 'manual'): void {
    const useManualDraft = target === 'manual';
    const manualTitle = this.draftReport.title.trim();
    const manualBody = this.draftReport.body.trim();
    const manualMetrics: ReportMetrics = {
      completedTasks: 0,
      avgProgressPercent: 0,
      notes: this.buildSummaryFromBody(manualBody),
    };

    const activeReport = this.activeReport;
    const reportToSave = useManualDraft
      ? manualTitle && manualBody
        ? { title: manualTitle, body: manualBody, metrics: manualMetrics }
        : null
      : activeReport
      ? {
          title: activeReport.title,
          body: activeReport.body,
          metrics:
            activeReport.metrics ?? {
              completedTasks: 0,
              avgProgressPercent: 0,
              notes: this.buildSummaryFromBody(activeReport.body),
            },
        }
      : null;

    if (!reportToSave) {
      return;
    }

    this.projectId$.pipe(take(1)).subscribe(projectId => {
      // TODO: roleチェック (admin/memberのみ保存可能、viewerは拒否)
      if (!projectId) {
        console.warn('saveReport: projectId is not available');
        return;
      }

      const reportsRef = collection(this.firestore, `projects/${projectId}/reports`);
      addDoc(reportsRef, {
        title: reportToSave.title,
        body: reportToSave.body,
        metrics: reportToSave.metrics,
        createdAt: serverTimestamp(),
      })
        .then(docRef => {
          console.log('saved!', docRef.id);
          const createdAt = new Date();
          this.activeReport = {
            id: docRef.id,
            title: reportToSave.title,
            createdAt: createdAt.toISOString(),
            body: reportToSave.body,
            metrics: reportToSave.metrics,
          };
          this.manualFormOpen = false;
          this.draftReport = { title: '', body: '' };
        })
        .catch(error => {
          console.warn('saveReport failed', error);
        });
    });
  }

  setActiveReport(report: ReportEntry): void {
    this.activeReport = report;
  }

  createdAtToDate(value: ReportEntry['createdAt']): Date {
    if (typeof value === 'string') {
      return new Date(value);
    }
    return value.toDate();
  }

  private buildSummaryFromBody(body: string): string {
    const normalized = body.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 80) {
      return normalized;
    }
    return `${normalized.slice(0, 77)}…`;
  }
}
