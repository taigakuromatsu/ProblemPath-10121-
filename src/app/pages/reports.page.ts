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
import { collection, collectionData, Firestore, Timestamp } from '@angular/fire/firestore';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, catchError, combineLatest, map, Observable, of, switchMap } from 'rxjs';

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
    // TODO: call backend Function (Gemini) to generate draft for current projectId
    console.log('Generating AI draft report...');
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

  saveManualReport(): void {
    const title = this.draftReport.title.trim();
    const body = this.draftReport.body.trim();
    if (!title || !body) {
      return;
    }

    const createdAt = new Date();
    const newReport: ReportEntry = {
      id: `manual-${createdAt.toISOString()}`,
      title,
      createdAt: createdAt.toISOString(),
      body,
      metrics: {
        completedTasks: 0,
        avgProgressPercent: 0,
        notes: this.buildSummaryFromBody(body),
      },
    };

    const manualReports = this.manualReportsSubject.value;
    this.manualReportsSubject.next([newReport, ...manualReports]);
    this.activeReport = newReport;
    this.manualFormOpen = false;
    this.draftReport = { title: '', body: '' };
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
