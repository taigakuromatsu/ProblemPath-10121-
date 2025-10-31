import { Component } from '@angular/core';
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
import { Observable } from 'rxjs';

import { CurrentProjectService } from '../services/current-project.service';

interface ReportMetrics {
  completedTasks?: number;
  avgProgressPercent?: number;
  notes?: string;
}

interface ReportItem {
  id: string;
  title: string;
  createdAt: Date;
  summary: string;
  body: string;
  source: 'ai' | 'manual';
  metrics?: ReportMetrics;
}

interface DraftReport {
  title: string;
  body: string;
}

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
  readonly projectId$: Observable<string | null>;
  // TODO: Replace mock reports with Firestore-backed collection once API is ready.
  reports: ReportItem[] = [
    {
      id: 'rpt-20240407',
      title: '2024-W14 Progress',
      createdAt: new Date('2024-04-07T09:00:00+09:00'),
      summary: '完了5件 / 平均進捗84% / UI改善がメイン',
      body:
        '今週はUI改善関連のタスクが中心。ユーザーからのフィードバックを受けたナビゲーション調整が完了し、モバイル向けの最適化も進捗。',
      source: 'ai',
      metrics: {
        completedTasks: 5,
        avgProgressPercent: 84,
        notes: 'UI改善を重点対応',
      },
    },
    {
      id: 'rpt-20240331',
      title: '2024-W13 Check-in',
      createdAt: new Date('2024-03-31T09:00:00+09:00'),
      summary: '完了3件 / 平均進捗76% / 課題ヒアリング継続',
      body:
        'ヒアリング結果を分析し、今後の改善テーマを整理。バックエンド側の安定化タスクは進行中で、来週も継続。',
      source: 'manual',
      metrics: {
        completedTasks: 3,
        avgProgressPercent: 76,
      },
    },
  ];

  selectedReportId = this.reports[0]?.id;
  manualFormOpen = false;
  draftReport: DraftReport = { title: '', body: '' };

  constructor(private readonly currentProject: CurrentProjectService) {
    this.projectId$ = this.currentProject.projectId$;
  }

  get activeReport(): ReportItem | undefined {
    return this.reports.find(report => report.id === this.selectedReportId);
  }

  generateAiDraft(): void {
    // TODO: Connect with Cloud Functions (functions/src/ai.ts) to request Gemini-generated drafts.
    // TODO: Restrict this button to editors/admin roles once role checks are wired.
    console.log('generate via AI');
  }

  openManualReportForm(): void {
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
    const newReport: ReportItem = {
      id: `manual-${createdAt.toISOString()}`,
      title,
      createdAt,
      summary: this.buildSummaryFromBody(body),
      body,
      source: 'manual',
    };

    this.reports = [newReport, ...this.reports];
    this.selectedReportId = newReport.id;
    this.manualFormOpen = false;
    this.draftReport = { title: '', body: '' };
  }

  selectReport(reportId: string): void {
    this.selectedReportId = reportId;
  }

  private buildSummaryFromBody(body: string): string {
    const normalized = body.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 80) {
      return normalized;
    }
    return `${normalized.slice(0, 77)}…`;
  }
}
