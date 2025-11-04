import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Task, Status } from '../models/types';
import { Observable, combineLatest, map } from 'rxjs';

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
  arrayUnion as nativeArrayUnion,
  arrayRemove as nativeArrayRemove,
} from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';

const OPEN_STATUSES: Status[] = ['not_started','in_progress'];

@Injectable({ providedIn: 'root' })
export class TasksService {

  constructor(
    private fs: Firestore,
  ) {}

  private base(projectId: string) { return `projects/${projectId}/problems`; }

  // …クラス内のユーティリティ: 重複排除
  private dedupeById(list: Task[]): Task[] {
    const m = new Map<string, Task>();
    for (const t of list) if (t?.id) m.set(t.id!, t);
    return Array.from(m.values());
  }

  private filterVisible(list: Task[]): Task[] {
    return list.filter(t => !(t as any)?.softDeleted).filter(t => !((t as any)?.recurrenceTemplate));
  }

  // ===== リアルタイム一覧 =====
  // 互換: listByIssue(problemId, issueId) は 'default' を使用
  listByIssue(problemId: string, issueId: string): Observable<Task[]>;
  listByIssue(projectId: string, problemId: string, issueId: string): Observable<Task[]>;
  listByIssue(arg1: string, arg2: string, arg3?: string): Observable<Task[]> {
    const legacy = !arg3;
    const pid = legacy ? 'default' : arg1;
    const problemId = legacy ? arg1 : arg2;
    const issueId = legacy ? arg2 : (arg3 as string);
    const path = `${this.base(pid)}/${problemId}/issues/${issueId}/tasks`;
    const colRef = nativeCollection(this.fs as any, path);
    const q = nativeQuery(
      colRef,
      nativeWhere('softDeleted','==', false),
      nativeOrderBy('order', 'asc'),
      nativeOrderBy('createdAt', 'asc')
    );
    return (rxCollectionData(q as any, { idField: 'id' }) as Observable<Task[]>)
      .pipe(map((xs: Task[]) => this.filterVisible(xs)));
  }

  // ===== 作成 =====
  // 互換: create(problemId, issueId, t) は 'default' を使用
  async create(problemId: string, issueId: string, t: Partial<Task>): Promise<any>;
  async create(projectId: string, problemId: string, issueId: string, t: Partial<Task>): Promise<any>;
  async create(arg1: string, arg2: string, arg3: Partial<Task> | string, arg4?: Partial<Task>) {
    const legacy = typeof arg3 !== 'string';
    const pid = legacy ? 'default' : arg1;
    const problemId = legacy ? arg1 : arg2;
    const issueId = legacy ? arg2 : (arg3 as string);
    const t = legacy ? (arg3 as Partial<Task>) : (arg4 ?? {});
    const colRef = nativeCollection(this.fs as any, `${this.base(pid)}/${problemId}/issues/${issueId}/tasks`);
    const order = t.order ?? await this.nextOrder(pid, problemId, issueId);
    const isTemplate = !!t.recurrenceRule?.freq;
    const interval = Math.max(1, Number(t.recurrenceRule?.interval ?? 1));
    const normalizedRule = isTemplate
      ? { freq: t.recurrenceRule!.freq, interval }
      : null;
    const anchorDate = isTemplate
      ? (t.recurrenceAnchorDate ?? t.dueDate ?? null)
      : (t.recurrenceAnchorDate ?? null);
    const recurrenceTemplate = isTemplate ? true : t.recurrenceTemplate === true;

    return nativeAddDoc(colRef, {
      title: t.title ?? 'Untitled Task',
      description: t.description ?? '',
      status: t.status ?? 'not_started',
      progress: t.progress ?? 0,
      boardColumnId: t.boardColumnId ?? null,
      tags: t.tags ?? [],
      assignees: t.assignees ?? [],
      order,
      dueDate: isTemplate ? null : (t.dueDate ?? null),
      priority: t.priority ?? 'mid',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      recurrenceRule: normalizedRule,
      recurrenceTemplate,
      recurrenceParentId: t.recurrenceParentId ?? null,
      recurrenceInstanceIndex: t.recurrenceInstanceIndex ?? null,
      recurrenceAnchorDate: anchorDate,
      // TODO: このメタ情報はCloud Functionsの集計(refreshAnalyticsSummary)で使うので必須
      projectId: pid,
      problemId,
      issueId,
      softDeleted: false,
    });
  }

  // 並べ替え
  async moveUp(problemId: string, issueId: string, id: string, currentOrder: number): Promise<void>;
  async moveUp(projectId: string, problemId: string, issueId: string, id: string, currentOrder: number): Promise<void>;
  async moveUp(arg1: string, arg2: string, arg3: string | number, arg4?: number | string, arg5?: number): Promise<void> {
    const legacy = typeof arg3 === 'string' && typeof arg4 === 'number';
    const pid = legacy ? 'default' : arg1;
    const problemId = legacy ? arg1 : arg2;
    const issueId = legacy ? arg2 : (arg3 as string);
    const id = legacy ? (arg3 as string) : (arg4 as string);
    const currentOrder = legacy ? (arg4 as number) : (arg5 as number);

    const colRef = nativeCollection(this.fs as any, `${this.base(pid)}/${problemId}/issues/${issueId}/tasks`);
    const q = nativeQuery(colRef, nativeWhere('order', '<', currentOrder), nativeOrderBy('order', 'desc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return;
    const neighbor = snap.docs[0];
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, `${this.base(pid)}/${problemId}/issues/${issueId}/tasks/${id}`);
    const neighborOrder = (neighbor.data() as any).order ?? 0;
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(neighbor.ref, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }

  async moveDown(problemId: string, issueId: string, id: string, currentOrder: number): Promise<void>;
  async moveDown(projectId: string, problemId: string, issueId: string, id: string, currentOrder: number): Promise<void>;
  async moveDown(arg1: string, arg2: string, arg3: string | number, arg4?: number | string, arg5?: number): Promise<void> {
    const legacy = typeof arg3 === 'string' && typeof arg4 === 'number';
    const pid = legacy ? 'default' : arg1;
    const problemId = legacy ? arg1 : arg2;
    const issueId = legacy ? arg2 : (arg3 as string);
    const id = legacy ? (arg3 as string) : (arg4 as string);
    const currentOrder = legacy ? (arg4 as number) : (arg5 as number);

    const colRef = nativeCollection(this.fs as any, `${this.base(pid)}/${problemId}/issues/${issueId}/tasks`);
    const q = nativeQuery(colRef, nativeWhere('order', '>', currentOrder), nativeOrderBy('order', 'asc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return;
    const neighbor = snap.docs[0];
    const batch = nativeWriteBatch(this.fs as any);
    const aRef = nativeDoc(this.fs as any, `${this.base(pid)}/${problemId}/issues/${issueId}/tasks/${id}`);
    const neighborOrder = (neighbor.data() as any).order ?? 0;
    batch.update(aRef, { order: neighborOrder, updatedAt: serverTimestamp() });
    batch.update(neighbor.ref, { order: currentOrder, updatedAt: serverTimestamp() });
    await batch.commit();
  }

  // ===== 更新・削除 =====
  async update(problemId: string, issueId: string, id: string, patch: Partial<Task>): Promise<void>;
  async update(projectId: string, problemId: string, issueId: string, id: string, patch: Partial<Task>): Promise<void>;
  async update(arg1: string, arg2: string, arg3: string | Partial<Task>, arg4?: string | Partial<Task>, arg5?: Partial<Task>): Promise<void> {
    const legacy = typeof arg3 === 'string' && typeof arg4 !== 'string';
    const pid = legacy ? 'default' : arg1;
    const problemId = legacy ? arg1 : arg2;
    const issueId = legacy ? arg2 : (arg3 as string);
    const id = legacy ? (arg3 as string) : (arg4 as string);
    const patch = legacy ? (arg4 as Partial<Task>) : (arg5 ?? {});
    const ref = nativeDoc(this.fs as any, `${this.base(pid)}/${problemId}/issues/${issueId}/tasks/${id}`);
    return nativeUpdateDoc(ref, {
      ...patch,
      // TODO: このメタ情報はCloud Functionsの集計(refreshAnalyticsSummary)で使うので必須
      projectId: pid,
      problemId,
      updatedAt: serverTimestamp(),
    }) as any;
  }

  async remove(problemId: string, issueId: string, id: string): Promise<void>;
  async remove(projectId: string, problemId: string, issueId: string, id: string): Promise<void>;
  async remove(arg1: string, arg2: string, arg3: string, arg4?: string): Promise<void> {
    const legacy = !arg4;
    const pid = legacy ? 'default' : arg1;
    const problemId = legacy ? arg1 : arg2;
    const issueId = legacy ? arg2 : arg3;
    const id = legacy ? arg3 : (arg4 as string);
  
    const base = `${this.base(pid)}/${problemId}/issues/${issueId}/tasks/${id}`;
    // 1) task 直下の attachments サブコレ削除
    await this.deleteCollection(`${base}/attachments`);
  
    // 2) task 本体削除
    const ref = nativeDoc(this.fs as any, `${this.base(pid)}/${problemId}/issues/${issueId}/tasks/${id}`);
    return nativeDeleteDoc(ref) as any;
  }

  private async nextOrder(projectId: string, problemId: string, issueId: string): Promise<number> {
    const colRef = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues/${issueId}/tasks`);
    const q = nativeQuery(colRef, nativeOrderBy('order', 'desc'), nativeLimit(1));
    const snap = await nativeGetDocs(q);
    if (snap.empty) return 1;
    const max = (snap.docs[0].data() as any).order ?? 0;
    return (Number(max) || 0) + 1;
  }

  // ====== 集計API（collectionGroup） ======
  // 互換: projectId 省略時は 'default' を使用
  listAllByDueRange(
    startYmd: string,
    endYmd: string,
    openOnly?: boolean,
    tags?: string[]
  ): Observable<Task[]>;
  listAllByDueRange(
    projectId: string,
    startYmd: string,
    endYmd: string,
    openOnly?: boolean,
    tags?: string[]
  ): Observable<Task[]>;
  listAllByDueRange(
    arg1: string,
    arg2: string,
    arg3?: string | boolean,
    arg4?: boolean | string[],
    arg5?: string[]
  ): Observable<Task[]> {
    const legacy = typeof arg3 !== 'string' && typeof arg3 !== 'undefined';
    const pid = legacy ? 'default' : arg1;
    const startYmd = legacy ? arg1 : arg2;
    const endYmd   = legacy ? (arg2 as string) : (arg3 as string);
    const openOnly = (legacy ? (arg3 as boolean) : (arg4 as boolean)) ?? true;
    const tags     = (legacy ? (arg4 as string[]) : (arg5 as string[])) ?? [];

    const base = nativeCollectionGroup(this.fs as any, 'tasks');
    const tagFilter = (tags && tags.length > 0)
      ? [nativeWhere('tags', 'array-contains-any', tags.slice(0, 10))]
      : [];

    const q = nativeQuery(
      base,
      nativeWhere('projectId', '==', pid),
      nativeWhere('softDeleted','==', false),
      nativeWhere('dueDate', '>=', startYmd),
      nativeWhere('dueDate', '<=', endYmd),
      ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
      ...tagFilter,
      nativeOrderBy('dueDate', 'asc')
    );

    return (rxCollectionData(q as any, { idField: 'id' }) as Observable<Task[]>)
    .pipe(map((xs: Task[]) => this.filterVisible(xs)));
  }

  listAllOverdue(
    todayYmd: string,
    openOnly?: boolean,
    tags?: string[]
  ): Observable<Task[]>;
  listAllOverdue(
    projectId: string,
    todayYmd: string,
    openOnly?: boolean,
    tags?: string[]
  ): Observable<Task[]>;
  listAllOverdue(
    arg1: string,
    arg2?: string | boolean,
    arg3?: boolean | string[],
    arg4?: string[]
  ): Observable<Task[]> {
    const legacy   = typeof arg2 !== 'string' && typeof arg2 !== 'undefined';
    const pid      = legacy ? 'default' : arg1;
    const todayYmd = legacy ? arg1 : (arg2 as string);
    const openOnly = (legacy ? (arg2 as boolean) : (arg3 as boolean)) ?? true;
    const tags     = (legacy ? (arg3 as string[]) : (arg4 as string[])) ?? [];

    const base = nativeCollectionGroup(this.fs as any, 'tasks');
    const tagFilter = (tags && tags.length > 0)
      ? [nativeWhere('tags', 'array-contains-any', tags.slice(0, 10))]
      : [];

    const q = nativeQuery(
      base,
      nativeWhere('projectId', '==', pid),
      nativeWhere('softDeleted','==', false),
      nativeWhere('dueDate', '<', todayYmd),
      ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
      ...tagFilter,
      nativeOrderBy('dueDate', 'asc')
    );
    return (rxCollectionData(q as any, { idField: 'id' }) as Observable<Task[]>)
    .pipe(map((xs: Task[]) => this.filterVisible(xs)));
  }

  // --- listAllNoDue: オーバーロード2本 + 実装1本だけ ---
  listAllNoDue(
    openOnly?: boolean,
    tags?: string[]
  ): Observable<Task[]>;
  listAllNoDue(
    projectId: string,
    openOnly?: boolean,
    tags?: string[]
  ): Observable<Task[]>;
  listAllNoDue(
    arg1?: string | boolean,
    arg2?: boolean | string[],
    arg3?: string[]
  ): Observable<Task[]> {
    const isNew   = typeof arg1 === 'string';
    const pid      = isNew ? (arg1 as string) : 'default';
    const openOnly = isNew ? ((arg2 as boolean) ?? true) : ((arg1 as boolean) ?? true);
    const tags     = isNew ? ((arg3 as string[]) ?? []) : ((arg2 as string[]) ?? []);

    const base = nativeCollectionGroup(this.fs as any, 'tasks');
    const tagFilter = (tags && tags.length > 0)
      ? [nativeWhere('tags', 'array-contains-any', tags.slice(0, 10))]
      : [];

    const q = nativeQuery(
      base,
      nativeWhere('projectId', '==', pid),
      nativeWhere('softDeleted','==', false),
      nativeWhere('dueDate', '==', null),
      ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
      ...tagFilter,
      nativeOrderBy('createdAt', 'desc')
    );

    return (rxCollectionData(q as any, { idField: 'id' }) as Observable<Task[]>)
    .pipe(map((xs: Task[]) => this.filterVisible(xs)));
  }

    listAllInProject(
      projectId: string,
      openOnly: boolean = false,
      tags: string[] = []
    ): Observable<Task[]> {
  
      const base = nativeCollectionGroup(this.fs as any, 'tasks');
  
      // Firestore制約的に、tags はここではクエリ結合しづらいので
      // （array-contains-any等と他条件の複合制約が厳しいケースがある）
      // 一旦サーバーから全部取り、あとでクライアント側でフィルタする。
      const q = nativeQuery(
        base,
        nativeWhere('projectId', '==', projectId),
        nativeWhere('softDeleted', '==', false),
        ...(openOnly ? [nativeWhere('status', 'in', OPEN_STATUSES)] : []),
        nativeOrderBy('createdAt', 'asc')
      );
  
      const stream = rxCollectionData(q as any, { idField: 'id' }) as Observable<Task[]>;
  
      return stream.pipe(
        map(items => {
          // 念のためsoftDeleted二重フィルタ
          let ys = this.filterVisible(items);

          // openOnly が true の場合は done を除外
          if (openOnly) {
            const openSet = new Set(OPEN_STATUSES);
            ys = ys.filter(t => openSet.has(t.status as Status));
          }
  
          // tags指定がある場合はクライアント側でタグ絞り込み
          if (tags.length) {
            const tagSet = new Set(tags.slice(0, 10).map(s => s.trim()));
            ys = ys.filter(t => (t.tags ?? []).some(tag => tagSet.has(tag)));
          }
  
          return ys;
        })
      );
    }
  


    // --- 自分をアサイン / 解除 ---
    async assignMe(projectId: string, problemId: string, issueId: string, taskId: string, uid: string): Promise<void> {
      const ref = nativeDoc(this.fs as any, `${this.base(projectId)}/${problemId}/issues/${issueId}/tasks/${taskId}`);
      await nativeUpdateDoc(ref, { assignees: nativeArrayUnion(uid), updatedAt: serverTimestamp() } as any);
    }
  
    async unassignMe(projectId: string, problemId: string, issueId: string, taskId: string, uid: string): Promise<void> {
      const ref = nativeDoc(this.fs as any, `${this.base(projectId)}/${problemId}/issues/${issueId}/tasks/${taskId}`);
      await nativeUpdateDoc(ref, { assignees: nativeArrayRemove(uid), updatedAt: serverTimestamp() } as any);
    }
  
 // --- 自分のタスク横断取得（個人ToDo統合ビュー用） ---
 listMine(
  projectId: string,
  uid: string,
  openOnly: boolean = true,
  startYmd: string = '0000-01-01',
  endYmd: string = '9999-12-31',
  tags: string[] = []
): Observable<Task[]> {
  const base = nativeCollectionGroup(this.fs as any, 'tasks');

  // ← タグの where は入れない（array-contains と併用不可のため）
  const q = nativeQuery(
    base,
    nativeWhere('projectId', '==', projectId),
    nativeWhere('assignees', 'array-contains', uid),

    ...(openOnly ? [nativeWhere('status','in', OPEN_STATUSES)] : []),

    nativeWhere('softDeleted','==', false),
    nativeWhere('dueDate', '>=', startYmd),
    nativeWhere('dueDate', '<=', endYmd),
    nativeOrderBy('dueDate', 'asc')
  );

  const stream = rxCollectionData(q as any, { idField: 'id' }) as Observable<Task[]>;

  return stream.pipe(
    map(items => {
      // openOnly はクライアント側で
      items = this.filterVisible(items);
      if (openOnly) {
        const open = new Set(OPEN_STATUSES);
        items = items.filter(x => open.has(x.status as Status));
      }
      // タグもクライアント側で
      if (tags.length) {
        const set = new Set(tags.slice(0, 10).map(s => s.trim()));
        items = items.filter(t => (t.tags ?? []).some(tag => set.has(tag)));
      }
      return items;
    })
  );
}


// 自分にアサインされ、かつ dueDate == null のタスクを取得
listMineNoDue(
  projectId: string,
  uid: string,
  openOnly: boolean = true,
  tags: string[] = []
): Observable<Task[]> {
  const base = nativeCollectionGroup(this.fs as any, 'tasks');

  // ← タグの where は入れない
  const q = nativeQuery(
    base,
    nativeWhere('projectId', '==', projectId),
    nativeWhere('assignees', 'array-contains', uid),

    ...(openOnly ? [nativeWhere('status','in', OPEN_STATUSES)] : []),
    
    nativeWhere('softDeleted','==', false),
    nativeWhere('dueDate', '==', null),
    nativeOrderBy('createdAt', 'desc')
  );

  const stream = rxCollectionData(q as any, { idField: 'id' }) as Observable<Task[]>;

  return stream.pipe(
    map(xs => {
      let ys = this.filterVisible(xs);
      if (openOnly) ys = ys.filter(t => t.status !== 'done');
      if (tags.length) {
        const set = new Set(tags.slice(0, 10).map(s => s.trim()));
        ys = ys.filter(t => (t.tags ?? []).some(tag => set.has(tag)));
      }
      return ys;
    })
  );
}
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


