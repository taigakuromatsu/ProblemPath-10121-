import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Observable, map } from 'rxjs';
import { Issue, IssueLink, LinkType } from '../models/types';

const DEBUG_ISSUES = false; // ← 必要な時だけ true に


function commitIfAny(batch: ReturnType<typeof nativeWriteBatch>) {
  // Firestore の batched writes は 0 件 commit を許容しないケースがあるため
  // try/catch で包むより「何も積まれてなければ return」しておく。
  // @ts-ignore（内部APIに依存しないため単純に呼ぶだけ）
  if ((batch as any)._mutations?.length === 0) return Promise.resolve();
  return batch.commit();
}

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
  getDoc as nativeGetDoc,
  limit as nativeLimit,
  where as nativeWhere,
  writeBatch as nativeWriteBatch,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';

@Injectable({ providedIn: 'root' })
export class IssuesService {
  constructor(private fs: Firestore) {}

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

  // listByProblem()
  listByProblem(projectId: string, problemId: string): Observable<Issue[]> {
    this.dlog('[IssuesService.listByProblem]', { pid: projectId, problemId, path: `${this.base(projectId)}/${problemId}/issues` });
    const colRef = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues`);
    const q = nativeQuery(colRef, nativeWhere('visible','==', true), nativeOrderBy('order', 'asc'), nativeOrderBy('createdAt', 'asc'));
    return (rxCollectionData(q as any, { idField: 'id' }) as Observable<Issue[]>)
      .pipe(map((xs: any[]) => xs.filter((i: any) => !i?.softDeleted)));
  }

  // create
  async create(projectId: string, problemId: string, i: Partial<Issue>): Promise<any> {
    const colRef = nativeCollection(this.fs as any, `${this.base(projectId)}/${problemId}/issues`);
    const order = i.order ?? await this.nextOrder(projectId, problemId);

    // links は最小構成 { issueId, type } のみに正規化して保存
    const normLinks: IssueLink[] = Array.isArray(i.links)
      ? i.links.map(l => ({ issueId: (l as any).issueId, type: (l as any).type })).filter(l => l.issueId && l.type)
      : [];

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
      links: normLinks,
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

    // links が入ってきた場合は安全のため最小構成へ正規化
    let body: any = { ...patch, updatedAt: serverTimestamp() };
    if (patch.links) {
      body.links = (patch.links as any[]).map(l => ({ issueId: (l as any).issueId, type: (l as any).type }))
        .filter(l => l.issueId && l.type);
    }

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
  

  // 相互リンク（同一 Problem 内）: 追加 / 削除

  // 逆方向マップ
  private static readonly INVERSE: Record<LinkType, LinkType> = {
    relates: 'relates',
    duplicate: 'duplicate',
    blocks: 'depends_on',
    depends_on: 'blocks',
    same_cause: 'same_cause',
  };

  /**
   * 相互リンクを追加（同一 Problem 内）
   * createdBy は MVP では保存しない（arrayUnion/arrayRemove の一意性を保つため）。
   */
  async addLink(
    projectId: string,
    problemId: string,
    fromIssueId: string,
    toIssueId: string,
    type: LinkType,
    _createdBy: string
  ): Promise<void> {
    if (fromIssueId === toIssueId) return;
  
    const fromRef = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, fromIssueId));
    const toRef   = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, toIssueId));
  
    // どちらかが無ければ対称性を保つため何もしない（レース対策）
    const [fromSnap, toSnap] = await Promise.all([nativeGetDoc(fromRef), nativeGetDoc(toRef)]);
    if (!fromSnap.exists() || !toSnap.exists()) return;
  
    const batch = nativeWriteBatch(this.fs as any);
    const now = serverTimestamp();
  
    const fwd: IssueLink = { issueId: toIssueId, type };
    const rev: IssueLink = { issueId: fromIssueId, type: IssuesService.INVERSE[type] };
  
    batch.update(fromRef, { links: arrayUnion(fwd), updatedAt: now } as any);
    batch.update(toRef,   { links: arrayUnion(rev), updatedAt: now } as any);
  
    await commitIfAny(batch);
  }
  
  /** 相互リンクを削除（同一 Problem 内・片側だけでも必ず外す） */
  async removeLink(
    projectId: string,
    problemId: string,
    fromIssueId: string,
    toIssueId: string,
    type: LinkType
  ): Promise<void> {
    const fromRef = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, fromIssueId));
    const toRef   = nativeDoc(this.fs as any, this.issueDocPath(projectId, problemId, toIssueId));
  
    const [fromSnap, toSnap] = await Promise.all([nativeGetDoc(fromRef), nativeGetDoc(toRef)]);
  
    // どちらも無ければ何もしない
    if (!fromSnap.exists() && !toSnap.exists()) return;
  
    const batch = nativeWriteBatch(this.fs as any);
    const now = serverTimestamp();
  
    const fwd: IssueLink = { issueId: toIssueId, type };
    const rev: IssueLink = { issueId: fromIssueId, type: IssuesService.INVERSE[type] };
  
    if (fromSnap.exists()) batch.update(fromRef, { links: arrayRemove(fwd), updatedAt: now } as any);
    if (toSnap.exists())   batch.update(toRef,   { links: arrayRemove(rev), updatedAt: now } as any);
  
    await commitIfAny(batch);
  }

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

}



