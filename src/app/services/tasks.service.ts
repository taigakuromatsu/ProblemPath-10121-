import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Task, Status} from '../models/types';
import { Observable,combineLatest, map } from 'rxjs';


// 読み取りは rxfire、CRUD は Firebase SDK (native)
import {
  collectionGroup as nativeCollectionGroup,
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

const PROJECT_ID = 'default';
const OPEN_STATUSES: Status[] = ['not_started','in_progress','review_wait','fixing'];

@Injectable({ providedIn: 'root' })
 

export class TasksService {

  // …クラス内のユーティリティ: 重複排除
private dedupeById(list: Task[]): Task[] {
  const m = new Map<string, Task>();
  for (const t of list) if (t?.id) m.set(t.id!, t);
  return Array.from(m.values());
}

  private readonly base = 'projects/default/problems';

  constructor(private fs: Firestore) {}

  // Issue 配下の Task 一覧（リアルタイム）
  listByIssue(problemId: string, issueId: string): Observable<Task[]> {
    const path = `${this.base}/${problemId}/issues/${issueId}/tasks`;
    const colRef = nativeCollection(this.fs as any, path);
    // order優先、同値時はcreatedAtで安定化
    const q = nativeQuery(
      colRef,
      nativeOrderBy('order', 'asc'),
      nativeOrderBy('createdAt', 'asc')
    );
    return rxCollectionData(q as any, { idField: 'id' }) as Observable<Task[]>;
  }
  

  // 作成
  async create(problemId: string, issueId: string, t: Partial<Task>) {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks`);
    const order = t.order ?? await this.nextOrder(problemId, issueId);  // ★ 追加
    return nativeAddDoc(colRef, {
      title: t.title ?? 'Untitled Task',
      description: t.description ?? '',
      status: t.status ?? 'not_started',
      progress: t.progress ?? 0,
      tags: t.tags ?? [],
      assignees: t.assignees ?? [],
      order,                                                           // ★ 採番保存
      dueDate: t.dueDate ?? null,
      priority: t.priority ?? 'mid',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      recurrenceRule: t.recurrenceRule ?? null,
      problemId,
      issueId,
      projectId: 'default',
    });
  }
  
  // ★ 上へ：直前の order の Task と入れ替える
async moveUp(problemId: string, issueId: string, id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks`);
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
    const aRef = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks/${id}`);
    const bRef = neighbor.ref;
  
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(bRef, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }
  
  // ★ 下へ：直後の order の Task と入れ替える
  async moveDown(problemId: string, issueId: string, id: string, currentOrder: number): Promise<void> {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks`);
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
    const aRef = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks/${id}`);
    const bRef = neighbor.ref;
  
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(bRef, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }
  

  // 更新
  async update(problemId: string, issueId: string, id: string, patch: Partial<Task>) {
    const ref = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks/${id}`);
    return nativeUpdateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
  }

  // 削除
  async remove(problemId: string, issueId: string, id: string) {
    const ref = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks/${id}`);
    return nativeDeleteDoc(ref);
  }


  private async nextOrder(problemId: string, issueId: string): Promise<number> {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks`);
    const q = nativeQuery(colRef, nativeOrderBy('order', 'desc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return 1;
    const max = (snap.docs[0].data() as any).order ?? 0;
    return (Number(max) || 0) + 1;
  }

  /** 期限範囲（YYYY-MM-DD 文字列） */
listAllByDueRange(startYmd: string, endYmd: string, openOnly = true): Observable<Task[]> {
  const base = nativeCollectionGroup(this.fs as any, 'tasks');

  // 新データ（projectId あり）
  const qScoped = nativeQuery(
    base,
    nativeWhere('projectId', '==', PROJECT_ID),
    nativeWhere('dueDate', '>=', startYmd),
    nativeWhere('dueDate', '<=', endYmd),
    ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
    nativeOrderBy('dueDate', 'asc')
  );

  // 旧データ（projectId 無しも拾うため、フィルタを付けない）
  const qLegacy = nativeQuery(
    base,
    nativeWhere('dueDate', '>=', startYmd),
    nativeWhere('dueDate', '<=', endYmd),
    ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
    nativeOrderBy('dueDate', 'asc')
  );

  const a$ = rxCollectionData(qScoped as any, { idField: 'id' }) as Observable<Task[]>;
  const b$ = rxCollectionData(qLegacy as any, { idField: 'id' }) as Observable<Task[]>;

  return combineLatest([a$, b$]).pipe(
    map(([a, b]) => this.dedupeById([...(a ?? []), ...(b ?? [])]))
  );
}

/** 期限切れ（todayYmd より前、YYYY-MM-DD 文字列） */
listAllOverdue(todayYmd: string, openOnly = true): Observable<Task[]> {
  const base = nativeCollectionGroup(this.fs as any, 'tasks');

  const qScoped = nativeQuery(
    base,
    nativeWhere('projectId', '==', PROJECT_ID),
    nativeWhere('dueDate', '<', todayYmd),
    ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
    nativeOrderBy('dueDate', 'asc')
  );

  const qLegacy = nativeQuery(
    base,
    nativeWhere('dueDate', '<', todayYmd),
    ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
    nativeOrderBy('dueDate', 'asc')
  );

  const a$ = rxCollectionData(qScoped as any, { idField: 'id' }) as Observable<Task[]>;
  const b$ = rxCollectionData(qLegacy as any, { idField: 'id' }) as Observable<Task[]>;

  return combineLatest([a$, b$]).pipe(
    map(([a, b]) => this.dedupeById([...(a ?? []), ...(b ?? [])]))
  );
}

/** 期限未設定（null） */
listAllNoDue(openOnly = true): Observable<Task[]> {
  const base = nativeCollectionGroup(this.fs as any, 'tasks');

  const qScoped = nativeQuery(
    base,
    nativeWhere('projectId', '==', PROJECT_ID),
    nativeWhere('dueDate', '==', null),
    ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
    nativeOrderBy('createdAt', 'desc')
  );

  // 旧データは「dueDate フィールド自体が存在しない」可能性があり、
  // Firestore では「存在しない」を条件で拾えないため、
  // ここは qScoped のみ（＝null 保存分のみ）を対象にします。
  // ※どうしても missing も拾いたい場合は backfill で null を入れてください。

  const a$ = rxCollectionData(qScoped as any, { idField: 'id' }) as Observable<Task[]>;
  return a$;
}

}

