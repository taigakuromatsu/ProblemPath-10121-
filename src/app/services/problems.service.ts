import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Problem } from '../models/types';

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
  private readonly colPath = 'projects/default/problems';

  constructor(private fs: Firestore) {}

  // 一覧（リアルタイム）
  list(): Observable<Problem[]> {
    const colRef = nativeCollection(this.fs as any, this.colPath);
    // ★ order優先、同値時はcreatedAtで安定化
    const q = nativeQuery(colRef,
      nativeOrderBy('order', 'asc'),
      nativeOrderBy('createdAt', 'asc')
    );
    return rxCollectionData(q as any, { idField: 'id' }) as Observable<Problem[]>;
  }
  
    // ★ 追加：最大orderを取り、+1で次の順序を割り当て
    private async nextOrder(): Promise<number> {
        const colRef = nativeCollection(this.fs as any, this.colPath);
        const q = nativeQuery(colRef, nativeOrderBy('order', 'desc'), nativeLimit(1));
        const snap = await nativeGetDocs(q);
        if (snap.empty) return 1;
        const max = (snap.docs[0].data() as any).order ?? 0;
        return (Number(max) || 0) + 1;
    }
  

  // 作成
  async create(p: Partial<Problem>) {
    const colRef = nativeCollection(this.fs as any, this.colPath);
    const order = (p.order ?? await this.nextOrder());   
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
      template: p.template ?? {}
    });
  }
  

  // 更新
  async update(id: string, patch: Partial<Problem>) {
    const ref = nativeDoc(this.fs as any, `${this.colPath}/${id}`);
    return nativeUpdateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
  }


  // ★ 上へ：直前の order のドキュメントを見つけて order を入れ替える
async moveUp(id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, this.colPath);
    // currentOrder より小さい中で一番近いもの
    const q = nativeQuery(
      colRef,
      nativeWhere('order', '<', currentOrder),
      nativeOrderBy('order', 'desc'),
      nativeLimit(1)
    );
    const snap = await nativeGetDocs(q);
    if (snap.empty) return; // 先頭なら何もしない
    const neighbor = snap.docs[0];
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, `${this.colPath}/${id}`);
    const bRef = neighbor.ref;
    const neighborOrder = (neighbor.data() as any).order ?? 0;
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(bRef, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }
  
  // ★ 下へ：直後の order のドキュメントと入れ替える
  async moveDown(id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, this.colPath);
    // currentOrder より大きい中で一番近いもの
    const q = nativeQuery(
      colRef,
      nativeWhere('order', '>', currentOrder),
      nativeOrderBy('order', 'asc'),
      nativeLimit(1)
    );
    const snap = await nativeGetDocs(q);
    if (snap.empty) return; // 末尾なら何もしない
    const neighbor = snap.docs[0];
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, `${this.colPath}/${id}`);
    const bRef = neighbor.ref;
    const neighborOrder = (neighbor.data() as any).order ?? 0;
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(bRef, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }


  
  // ★ 追加: コレクションをバッチで小分け削除（上限500対策）
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

  // ★ 追加: 特定 Problem 配下の issues とその tasks を全削除
  private async deleteAllIssuesAndTasks(problemId: string, batchSize = 200): Promise<void> {
    const issuesColPath = `${this.colPath}/${problemId}/issues`;

    // issues を小分けで読み出し → 各 issue の tasks を削除 → issue 自体をバッチ削除
    while (true) {
      const issuesColRef = nativeCollection(this.fs as any, issuesColPath);
      const q = nativeQuery(issuesColRef, nativeLimit(batchSize));
      const snap = await nativeGetDocs(q);
      if (snap.empty) break;

      // 1) それぞれの issue の tasks を先に削除
      for (const issueDoc of snap.docs) {
        const issueId = issueDoc.id;
        const tasksPath = `${issuesColPath}/${issueId}/tasks`;
        await this.deleteCollection(tasksPath); // tasks 全削除
      }

      // 2) issue 本体をまとめて削除
      const batch = nativeWriteBatch(this.fs as any);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // ★ 修正: 削除（Problem 本体の前に配下を再帰削除）
  async remove(id: string) {
    // 1) 配下の issues と tasks を全削除
    await this.deleteAllIssuesAndTasks(id);

    // 2) problem ドキュメントを削除
    const problemRef = nativeDoc(this.fs as any, `${this.colPath}/${id}`);
    return nativeDeleteDoc(problemRef);
  }
  
}


