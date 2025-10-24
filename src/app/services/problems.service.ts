import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Problem } from '../models/types';

const DEBUG_PROBLEMS = false; // ← 必要な時だけ true に

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
export class ProblemsService {
  constructor(private fs: Firestore) {}

  private colPath(projectId: string) {
    if (!projectId) throw new Error('[ProblemsService] projectId is required');
    return `projects/${projectId}/problems`;
  }
  
  private dlog(...args: any[]) {
    if (DEBUG_PROBLEMS) console.debug(...args);
  }

  // -------- list --------
  list(projectId: string): Observable<Problem[]> {
    this.dlog('[ProblemsService.list]', { pid: projectId, path: this.colPath(projectId) });
    const colRef = nativeCollection(this.fs as any, this.colPath(projectId));
    const q = nativeQuery(
      colRef,
      nativeOrderBy('order', 'asc'),
      nativeOrderBy('createdAt', 'asc')
    );
    return rxCollectionData(q as any, { idField: 'id' }) as Observable<Problem[]>;
  }


  // -------- nextOrder（内部ユーティリティ） --------
  private async nextOrder(projectId: string): Promise<number> {
    const colRef = nativeCollection(this.fs as any, this.colPath(projectId));
    const q = nativeQuery(colRef, nativeOrderBy('order', 'desc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return 1;
    const max = (snap.docs[0].data() as any).order ?? 0;
    return (Number(max) || 0) + 1;
  }

  // -------- create --------
// -------- create --------
async create(projectId: string, p: Partial<Problem>): Promise<any> {
  const colRef = nativeCollection(this.fs as any, this.colPath(projectId));
  const order = p.order ?? await this.nextOrder(projectId);

  const rawDef = (p as any).problemDef;
  let problemDef: any | undefined;
  if (rawDef) {
    const phenomenon = (rawDef.phenomenon ?? '').trim();
    const goal = (rawDef.goal ?? '').trim();
    const updatedBy = rawDef.updatedBy ?? '';
  
    problemDef = { phenomenon, goal, updatedBy, updatedAt: serverTimestamp() };
  
    const cause = (rawDef.cause ?? '').trim();
    const solution = (rawDef.solution ?? '').trim();
    if (cause) problemDef.cause = cause;           // 空なら付けない
    if (solution) problemDef.solution = solution;  // 空なら付けない
  }
  

  return nativeAddDoc(colRef, {
    title: p.title ?? 'Untitled',
    description: p.description ?? '',
    status: p.status ?? 'not_started',
    progress: p.progress ?? 0,
    tags: p.tags ?? [],
    assignees: p.assignees ?? [],
    order,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    template: p.template ?? {},
    ...(problemDef ? { problemDef } : {})
  });
}


  // -------- update --------
  async update(projectId: string, id: string, patch: Partial<Problem>): Promise<void> {
    const ref = nativeDoc(this.fs as any, `${this.colPath(projectId)}/${id}`);
    return nativeUpdateDoc(ref, { ...patch, updatedAt: serverTimestamp() }) as any;
  }

  // 並べ替え
  async moveUp(projectId: string, id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, this.colPath(projectId));
    const q = nativeQuery(
      colRef,
      nativeWhere('order', '<', currentOrder),
      nativeOrderBy('order', 'desc'),
      nativeLimit(1)
    );
    const snap = await nativeGetDocs(q);
    if (snap.empty) return;

    const neighbor = snap.docs[0];
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, `${this.colPath(projectId)}/${id}`);
    const neighborOrder = (neighbor.data() as any).order ?? 0;
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(neighbor.ref, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }

  async moveDown(projectId: string, id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, this.colPath(projectId));
    const q = nativeQuery(
      colRef,
      nativeWhere('order', '>', currentOrder),
      nativeOrderBy('order', 'asc'),
      nativeLimit(1)
    );
    const snap = await nativeGetDocs(q);
    if (snap.empty) return;

    const neighbor = snap.docs[0];
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, `${this.colPath(projectId)}/${id}`);
    const neighborOrder = (neighbor.data() as any).order ?? 0;
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(neighbor.ref, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }

  // 再帰削除ユーティリティは変更なし
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

  private async deleteAllIssuesAndTasks(projectId: string, problemId: string, batchSize = 200): Promise<void> {
    const issuesColPath = `${this.colPath(projectId)}/${problemId}/issues`;
    while (true) {
      const issuesColRef = nativeCollection(this.fs as any, issuesColPath);
      const q = nativeQuery(issuesColRef, nativeLimit(batchSize));
      const snap = await nativeGetDocs(q);
      if (snap.empty) break;

      for (const issueDoc of snap.docs) {
        const issueId = issueDoc.id;
        const tasksPath = `${issuesColPath}/${issueId}/tasks`;
        await this.deleteCollection(tasksPath);
      }
      const batch = nativeWriteBatch(this.fs as any);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  async remove(projectId: string, id: string): Promise<void> {
    await this.deleteAllIssuesAndTasks(projectId, id);
    const problemRef = nativeDoc(this.fs as any, `${this.colPath(projectId)}/${id}`);
    return nativeDeleteDoc(problemRef) as any;
  }
}
