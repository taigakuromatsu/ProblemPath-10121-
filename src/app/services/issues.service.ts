import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Issue } from '../models/types';

const DEBUG_ISSUES = false; // ← 必要な時だけ true に

// 読み取りは rxfire、参照は Firebase SDK (native)
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
  constructor(private fs: Firestore) {}
  private base(projectId: string) {
    if (!projectId) throw new Error('[IssuesService] projectId is required');
    return `projects/${projectId}/problems`;
  }

  private dlog(...args: any[]) {
    if (DEBUG_ISSUES) console.debug(...args);
  }

  // --- listByProblem ---
  listByProblem(projectId: string, problemId: string): Observable<Issue[]> {
    this.dlog('[IssuesService.listByProblem]', {
      pid: projectId, problemId,
      path: `${this.base(projectId)}/${problemId}/issues`
    });
    const colRef = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues`);
    const q = nativeQuery(colRef, nativeOrderBy('order', 'asc'), nativeOrderBy('createdAt', 'asc'));
    return rxCollectionData(q as any, { idField: 'id' }) as Observable<Issue[]>;
  }

  // --- create ---
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
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      links: i.links ?? [],
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
    const aRef = nativeDoc(this.fs as any, `${this.base(projectId)}/${problemId}/issues/${id}`);
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
    const aRef = nativeDoc(this.fs as any, `${this.base(projectId)}/${problemId}/issues/${id}`);
    batch.update(aRef, { order: (neighbor.data() as any).order ?? 0, updatedAt: serverTimestamp() });
    batch.update(neighbor.ref, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }

  // --- update ---
  async update(projectId: string, problemId: string, id: string, patch: Partial<Issue>): Promise<void> {
    const ref = nativeDoc(this.fs as any, `${this.base(projectId)}/${problemId}/issues/${id}`);
    return nativeUpdateDoc(ref, { ...patch, updatedAt: serverTimestamp() }) as any;
  }

  // --- remove（tasks 再帰削除→issue削除） ---
  async remove(projectId: string, problemId: string, id: string): Promise<void> {
    const tasksPath = `${this.base(projectId)}/${problemId}/issues/${id}/tasks`;
    await this.deleteCollection(tasksPath);
    const issueRef = nativeDoc(this.fs as any, `${this.base(projectId)}/${problemId}/issues/${id}`);
    return nativeDeleteDoc(issueRef) as any;
  }

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
}



