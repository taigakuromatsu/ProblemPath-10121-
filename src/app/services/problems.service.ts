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

  // 削除
  async remove(id: string) {
    const ref = nativeDoc(this.fs as any, `${this.colPath}/${id}`);
    return nativeDeleteDoc(ref);
  }
  
}


