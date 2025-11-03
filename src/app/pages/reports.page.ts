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
import { MatMenuModule } from '@angular/material/menu';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { docData } from '@angular/fire/firestore';
import {
  addDoc,
  collection,
  collectionData,
  deleteDoc,
  doc,
  Firestore,
  Timestamp,
  serverTimestamp,
  updateDoc,
} from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, catchError, combineLatest, map, Observable, of, switchMap, take } from 'rxjs';
import { Auth } from '@angular/fire/auth';

import { CurrentProjectService } from '../services/current-project.service';

export interface ReportMetrics {
  completedTasks: number;
  avgProgressPercent: number;
  notes: string;
}

export interface ReportEntry {
  id: string;
  title: string;
  createdAt: Timestamp | string | null | undefined;
  body: string;
  metrics: ReportMetrics;
  createdBy?: string;
  createdByName?: string;
  scope?: 'personal' | 'project';
  lang?: 'ja' | 'en';
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
    MatMenuModule,
    TranslateModule,
  ],
})
export class ReportsPage {
  private readonly currentProject = inject(CurrentProjectService);
  private readonly firestore = inject(Firestore);
  private readonly functions = inject(Functions);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(Auth);

  readonly projectId$: Observable<string | null> = this.currentProject.projectId$;

  private readonly manualReportsSubject = new BehaviorSubject<ReportEntry[]>([]);
  private readonly manualReports$ = this.manualReportsSubject.asObservable();

  /** 直近の生成指定（保存メタ用） */
  private lastScope: 'personal' | 'project' = 'project';
  private lastLang: 'ja' | 'en' = 'ja';

  /** 編集対象ID（nullなら新規作成） */
  private editingReportId: string | null = null;

  /** AI/手動の一時メトリクス（手動フォーム保存時に利用） */
  private pendingMetrics: ReportMetrics | null = null;

  private readonly firestoreReports$: Observable<ReportEntry[]> = this.projectId$.pipe(
    switchMap(projectId => {
      if (!projectId) return of([] as ReportEntry[]);
      const reportsRef = collection(this.firestore, `projects/${projectId}/reports`);
      return collectionData(reportsRef, { idField: 'id' }).pipe(
        map((entries) => (entries as any[]).map(e => this.normalizeEntry(e))),
        catchError(() => of([] as ReportEntry[])),
      );
    }),
  );

  readonly reports$: Observable<ReportEntry[]> = combineLatest([
    this.firestoreReports$,
    this.manualReports$,
  ]).pipe(map(([remoteReports, manualReports]) => [...manualReports, ...remoteReports]));

  activeReport: ReportEntry | null = null;
  manualFormOpen = false;
  draftReport: DraftReport = { title: '', body: '' };

  constructor() {
    this.reports$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(reports => {
        if (!reports.length) { this.activeReport = null; return; }
        if (this.activeReport) {
          const current = reports.find(r => r.id === this.activeReport?.id);
          if (current) { this.activeReport = current; return; }
        }
        this.activeReport = reports[0];
      });
  }

  /** 旧ショートカット（デフォはプロジェクト週次） */
  generateDraft(): void { this.generateDraftBy('project', 'weekly'); }

  generateDraftBy(scope: 'personal' | 'project', period: 'daily' | 'weekly'): void {
    this.projectId$.pipe(take(1)).subscribe(projectId => {
      if (!projectId) { console.warn('generateDraftBy: projectId is not available'); return; }

      const currentLang = this.translate.currentLang || this.translate.defaultLang || 'ja';
      const normalizedLang: 'ja' | 'en' = currentLang.startsWith('en') ? 'en' : 'ja';
      this.lastScope = scope;
      this.lastLang = normalizedLang;

      const callable = httpsCallable<
        { projectId: string; scope: 'personal' | 'project'; period: 'daily' | 'weekly'; lang: 'ja' | 'en' },
        { title: string; body: string; metrics: { completedTasks: number; avgProgressPercent: number; notes: string } }
      >(this.functions, 'generateProgressReportDraft');

      callable({ projectId, scope, period, lang: normalizedLang })
        .then(result => {
          const data = result.data;

          // ★ ここがポイント：AI下書きを手動フォームへ流し込む
          this.manualFormOpen = true;
          this.draftReport = { title: data.title, body: data.body };
          this.pendingMetrics = data.metrics ?? {
            completedTasks: 0,
            avgProgressPercent: 0,
            notes: this.buildSummaryFromBody(data.body),
          };
          this.editingReportId = null;
          // プレビューはそのまま（必要なら this.activeReport = null; にしてもOK）
        })
        .catch(error => console.warn('Failed to generate report draft', error));
    });
  }

  addManualReport(): void {
    this.manualFormOpen = true;
    this.draftReport = { title: '', body: '' };
    this.pendingMetrics = null;
    this.editingReportId = null;
    // 手動作成はデフォでプロジェクト/現在言語
    const currentLang = this.translate.currentLang || this.translate.defaultLang || 'ja';
    this.lastScope = 'project';
    this.lastLang = currentLang.startsWith('en') ? 'en' : 'ja';
  }

  cancelManualReport(): void {
    this.manualFormOpen = false;
    this.draftReport = { title: '', body: '' };
    this.pendingMetrics = null;
    this.editingReportId = null;
  }

  /** 一覧→プレビューで自分のレポートなら編集開始（フォームに読み込み） */
  editReport(report: ReportEntry): void {
    this.manualFormOpen = true;
    this.draftReport = { title: report.title, body: report.body };
    this.pendingMetrics = report.metrics ?? null;
    this.editingReportId = report.id;
    this.lastScope = report.scope ?? 'project';
    this.lastLang = report.lang ?? (this.translate.currentLang?.startsWith('en') ? 'en' : 'ja');
  }

  /** 保存：draftは新規、編集モードならupdate、手動フォームは新規/更新の両方対応 */
  saveReport(target: 'manual' | 'active' = 'manual'): void {
    const useManualDraft = target === 'manual';
    const currentLang = this.translate.currentLang || this.translate.defaultLang || 'ja';
    const normalizedLang: 'ja' | 'en' = currentLang.startsWith('en') ? 'en' : 'ja';

    const manualTitle = this.draftReport.title.trim();
    const manualBody = this.draftReport.body.trim();
    const manualMetrics: ReportMetrics = {
      completedTasks: 0,
      avgProgressPercent: 0,
      notes: this.buildSummaryFromBody(manualBody),
    };
    const metricsForManual = this.pendingMetrics ?? manualMetrics;

    const activeReport = this.activeReport;
    const reportToSave = useManualDraft
      ? (manualTitle && manualBody ? { title: manualTitle, body: manualBody, metrics: metricsForManual } : null)
      : activeReport
        ? {
            title: activeReport.title,
            body: activeReport.body,
            metrics: activeReport.metrics ?? {
              completedTasks: 0,
              avgProgressPercent: 0,
              notes: this.buildSummaryFromBody(activeReport.body),
            },
          }
        : null;

    if (!reportToSave) return;

    this.projectId$.pipe(take(1)).subscribe(async projectId => {
      if (!projectId) { console.warn('saveReport: projectId is not available'); return; }

      const uid = this.auth.currentUser?.uid;
      const displayName = this.auth.currentUser?.displayName || undefined;

      const reportsRef = collection(this.firestore, `projects/${projectId}/reports`);

      try {
        if (useManualDraft && this.editingReportId) {
          // 既存レポートの更新
          const ref = doc(this.firestore, `projects/${projectId}/reports/${this.editingReportId}`);
          await updateDoc(ref, {
            title: reportToSave.title,
            body: reportToSave.body,
            metrics: reportToSave.metrics,
            updatedAt: serverTimestamp(),
          } as any);

          this.activeReport = {
            id: this.editingReportId,
            title: reportToSave.title,
            createdAt: this.activeReport?.createdAt ?? new Date().toISOString(),
            body: reportToSave.body,
            metrics: reportToSave.metrics,
            createdBy: this.activeReport?.createdBy,
            createdByName: this.activeReport?.createdByName,
            scope: this.activeReport?.scope ?? this.lastScope,
            lang: this.activeReport?.lang ?? this.lastLang,
          };
        } else {
          // 新規保存（AI草案をフォームから保存 or 完全手動）
          const scope = this.lastScope ?? 'project';
          const lang = this.lastLang ?? normalizedLang;
          const docRef = await addDoc(reportsRef, {
            title: reportToSave.title,
            body: reportToSave.body,
            metrics: reportToSave.metrics,
            createdAt: serverTimestamp(),
            createdAtClient: new Date().toISOString(),
            // 保存メタ
            createdBy: uid ?? null,
            createdByName: displayName ?? null,
            scope,
            lang,
          } as any);

          const createdAt = new Date();
          this.activeReport = {
            id: docRef.id,
            title: reportToSave.title,
            createdAt: createdAt.toISOString(),
            body: reportToSave.body,
            metrics: reportToSave.metrics,
            createdBy: uid ?? undefined,
            createdByName: displayName ?? undefined,
            scope,
            lang,
          };
        }

        this.manualFormOpen = false;
        this.draftReport = { title: '', body: '' };
        this.pendingMetrics = null;
        this.editingReportId = null;
      } catch (error) {
        console.warn('saveReport failed', error);
      }
    });
  }

  readonly projectName$ = this.projectId$.pipe(
    switchMap(pid => {
      if (!pid) return of<string | null>(null);
      const ref = doc(this.firestore, `projects/${pid}`);
      return docData(ref).pipe(
        map((d: any) => (d?.meta?.name ?? d?.name ?? null) as string | null),
        catchError(() => of<string | null>(null)),
      );
    })
  );

  deleteReport(report: ReportEntry): void {
    if (!report?.id) return;
    this.projectId$.pipe(take(1)).subscribe(async projectId => {
      if (!projectId) return;
      try {
        await deleteDoc(doc(this.firestore, `projects/${projectId}/reports/${report.id}`));
        this.activeReport = null;
      } catch (e) {
        console.warn('deleteReport failed', e);
      }
    });
  }

  setActiveReport(report: ReportEntry): void { this.activeReport = report; }

  isMine(report: ReportEntry | null): boolean {
    const uid = this.auth.currentUser?.uid;
    return !!(report && uid && report.createdBy && report.createdBy === uid);
  }

  createdAtToDate(value: ReportEntry['createdAt']): Date {
    if (!value) return new Date(0);
    if (typeof value === 'string') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? new Date(0) : d;
    }
    const anyVal: any = value as any;
    if (typeof anyVal?.toDate === 'function') {
      try { return anyVal.toDate(); } catch {}
    }
    if (typeof anyVal?.seconds === 'number') {
      return new Date(anyVal.seconds * 1000);
    }
    return new Date(0);
  }

  private buildSummaryFromBody(body: string): string {
    const normalized = body.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 80) return normalized;
    return `${normalized.slice(0, 77)}…`;
  }

  private normalizeEntry(raw: any): ReportEntry {
    const title = typeof raw?.title === 'string' ? raw.title : '(no title)';
    const body  = typeof raw?.body === 'string'  ? raw.body  : '';
    const m = raw?.metrics ?? {};

    const metrics: ReportMetrics = {
      completedTasks: Number.isFinite(m?.completedTasks) ? m.completedTasks : 0,
      avgProgressPercent: Number.isFinite(m?.avgProgressPercent) ? m.avgProgressPercent : 0,
      notes: typeof m?.notes === 'string' ? m.notes : this.buildSummaryFromBody(body),
    };

    return {
      id: String(raw?.id ?? ''),
      title,
      createdAt: raw?.createdAt ?? null,
      body,
      metrics,
      createdBy: raw?.createdBy,
      createdByName: raw?.createdByName,
      scope: raw?.scope,
      lang: raw?.lang,
    };
  }
}

