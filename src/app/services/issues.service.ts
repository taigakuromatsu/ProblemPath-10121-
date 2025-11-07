import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Observable, map, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Issue } from '../models/types';
import { TasksService } from '../services/tasks.service';

const DEBUG_ISSUES = false; // ← 必要な時だけ true に

// （リンク機能廃止に伴い不要ユーティリティ削除

// Firebase SDK (native) ＋ rxfire
import {
  collection as nativeCollection,
  doc as nativeDoc,
  addDoc as nativeAddDoc,
  updateDoc as nativeUpdateDoc,
  deleteDoc as nativeDeleteDoc,
  serverTimestamp,
  query as nativeQuery,
  orderBy as nativeOrderBy,
  getDocs as nativeGetDocs,
  limit as nativeLimit,
  where as nativeWhere,
  writeBatch as nativeWriteBatch,
} from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';

@Injectable({ providedIn: 'root' })
export class IssuesService {
  constructor(private fs: Firestore, private tasks: TasksService) {}

  private base(projectId: string) {
    if (!projectId) throw new Error('[IssuesService] projectId is required');
    return `projects/${projectId}/problems`;
  }

  private issueDocPath(projectId: string, problemId: string, issueId: string) {
    if (!problemId) throw new Error('[IssuesService] problemId is required');
    if (!issueId) throw new Error('[IssuesService] issueId is required');
    return `${this.base(projectId)}/${problemId}/issues/${issueId}`;
  }

  private dlog(...args: any[]) {
    if (DEBUG_ISSUES) console.debug(...args);
  }

  // listByProblem$()
  listByProblem$(projectId: string, problemId: string): Observable<Issue[]> {
    this.dlog('[IssuesService.listByProblem$]', { pid: projectId, problemId, path: `${this.base(projectId)}/${problemId}/issues` });
    const col = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues`);
    const q = nativeQuery(col, nativeWhere('visible','==', true), nativeOrderBy('order', 'asc'), nativeOrderBy('createdAt', 'asc'));
    return rxCollectionData(q, { idField: 'id' }).pipe(
      map((xs: any[]) => xs.filter((i: any) => !i?.softDeleted) as Issue[]),
      catchError(err => {
        console.warn('[IssuesService.listByProblem$]', { projectId, problemId }, err);
        return of([] as Issue[]);
      })
    ) as Observable<Issue[]>;
  }

  // create
  async create(projectId: string, problemId: string, i: Partial<Issue>): Promise<any> {
    const colRef = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues`);
    const order = i.order ?? await this.nextOrder(projectId, problemId);


    return nativeAddDoc(colRef, {
      title: i.title ?? 'Untitled Issue',
      description: i.description ?? '',
      status: i.status ?? 'not_started',
      progress: i.progress ?? 0,
      tags: i.tags ?? [],
      assignees: i.assignees ?? [],
      order,
      visible:true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 並べ替え
  async moveUp(projectId: string, problemId: string, id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues`);
    const q = nativeQuery(colRef, nativeWhere('order', '<', currentOrder), nativeOrderBy('order', 'desc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return;

    const neighbor = snap.docs[0];
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, id));
    batch.update(aRef, { order: (neighbor.data() as any).order ?? 0, updatedAt: serverTimestamp() });
    batch.update(neighbor.ref, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }

  async moveDown(projectId: string, problemId: string, id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues`);
    const q = nativeQuery(colRef, nativeWhere('order', '>', currentOrder), nativeOrderBy('order', 'asc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return;

    const neighbor = snap.docs[0];
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, id));
    batch.update(aRef, { order: (neighbor.data() as any).order ?? 0, updatedAt: serverTimestamp() });
    batch.update(neighbor.ref, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }

  // update
  async update(projectId: string, problemId: string, id: string, patch: Partial<Issue>): Promise<void> {
    const ref = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, id));
    const body: any = { ...patch, updatedAt: serverTimestamp() };
    return nativeUpdateDoc(ref, body) as any;
  }

  // remove（tasks 再帰削除→issue削除）
  async remove(projectId: string, problemId: string, id: string): Promise<void> {
    const base = `${this.base(projectId)}/${problemId}/issues/${id}`;
  
    // 1) issue 直下の attachments
    await this.deleteCollection(`${base}/attachments`);
  
    // 2) tasks 配下
    const tasksPath = `${base}/tasks`;
    // 各 task の attachments を削除
    const taskSnap = await nativeGetDocs(nativeQuery(nativeCollection(this.fs as any, tasksPath), nativeLimit(200)));
    for (const d of taskSnap.docs) {
      await this.deleteCollection(`${tasksPath}/${d.id}/attachments`);
    }
    // tasks 自体を削除
    await this.deleteCollection(tasksPath);
  
    // 3) issue 自身を削除
    const issueRef = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, id));
    return nativeDeleteDoc(issueRef) as any;
  }
  
  // （リンク機能は廃止）


  // 内部ユーティリティ
  private async nextOrder(projectId: string, problemId: string): Promise<number> {
    const colRef = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues`);
    const q = nativeQuery(colRef, nativeOrderBy('order', 'desc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return 1;
    const max = (snap.docs[0].data() as any).order ?? 0;
    return (Number(max) || 0) + 1;
  }

  // 汎用小分け削除
  private async deleteCollection(path: string, batchSize = 300): Promise<void> {
    const colRef = nativeCollection(this.fs as any, path);
    while (true) {
      const q = nativeQuery(colRef, nativeLimit(batchSize));
      const snap = await nativeGetDocs(q);
      if (snap.empty) break;

      const batch = nativeWriteBatch(this.fs as any);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  async softDeleteWithTasks(
    projectId: string,
    problemId: string,
    issueId: string,
  ): Promise<void> {
    const issueRef = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, issueId));

    // 1) Issue 自身を softDelete
    await nativeUpdateDoc(issueRef, {
      softDeleted: true,
      visible: false,
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    } as any);

    // 2) 配下 Task を softDelete
    await this.tasks.markByIssueSoftDeleted(projectId, problemId, issueId, true);
  }

}



