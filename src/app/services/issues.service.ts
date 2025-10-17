import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Issue } from '../models/types';

// ★ 読み取りは rxfire、参照は Firebase SDK (native)
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
  // プロジェクトはまず固定（後で切替UIを作る）
  private readonly base = 'projects/default/problems';

  constructor(private fs: Firestore) {}

  // 問題（problemId）配下のIssue一覧を購読（リアルタイム）
  listByProblem(problemId: string): Observable<Issue[]> {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues`);
    // order を優先、同値時は createdAt で安定化
    const q = nativeQuery(
      colRef,
      nativeOrderBy('order', 'asc'),
      nativeOrderBy('createdAt', 'asc')
    );
    return rxCollectionData(q as any, { idField: 'id' }) as Observable<Issue[]>;
  }
  

  // 作成
  async create(problemId: string, i: Partial<Issue>) {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues`);
    const order = i.order ?? await this.nextOrder(problemId);  // ★ 追加
    return nativeAddDoc(colRef, {
      title: i.title ?? 'Untitled Issue',
      description: i.description ?? '',
      status: i.status ?? 'not_started',
      progress: i.progress ?? 0,
      tags: i.tags ?? [],
      assignees: i.assignees ?? [],
      order,                                                   // ★ 採番した順序を保存
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      links: i.links ?? [],
    });
  }
  
// ★ 上へ：直前の order の Issue と入れ替える
async moveUp(problemId: string, id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues`);
    const q = nativeQuery(
      colRef,
      nativeWhere('order', '<', currentOrder),
      nativeOrderBy('order', 'desc'),
      nativeLimit(1)
    );
    const snap = await nativeGetDocs(q);
    if (snap.empty) return; // 先頭なら何もしない
  
    const neighbor = snap.docs[0];
    const neighborOrder = (neighbor.data() as any).order ?? 0;
  
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${id}`);
    const bRef = neighbor.ref;
  
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(bRef, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }
  
  // ★ 下へ：直後の order の Issue と入れ替える
  async moveDown(problemId: string, id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues`);
    const q = nativeQuery(
      colRef,
      nativeWhere('order', '>', currentOrder),
      nativeOrderBy('order', 'asc'),
      nativeLimit(1)
    );
    const snap = await nativeGetDocs(q);
    if (snap.empty) return; // 末尾なら何もしない
  
    const neighbor = snap.docs[0];
    const neighborOrder = (neighbor.data() as any).order ?? 0;
  
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${id}`);
    const bRef = neighbor.ref;
  
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(bRef, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }
  


  // 更新
  async update(problemId: string, id: string, patch: Partial<Issue>) {
    const ref = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${id}`);
    return nativeUpdateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
  }

  // 削除
  async remove(problemId: string, id: string) {
    const ref = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${id}`);
    return nativeDeleteDoc(ref);
  }

  private async nextOrder(problemId: string): Promise<number> {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues`);
    const q = nativeQuery(colRef, nativeOrderBy('order', 'desc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return 1;
    const max = (snap.docs[0].data() as any).order ?? 0;
    return (Number(max) || 0) + 1;
  }
  


}

