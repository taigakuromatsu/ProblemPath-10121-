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
  serverTimestamp
} from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';

@Injectable({ providedIn: 'root' })
export class ProblemsService {
  private readonly colPath = 'projects/default/problems';

  constructor(private fs: Firestore) {}

  // 一覧（リアルタイム）
  list(): Observable<Problem[]> {
    const colRef = nativeCollection(this.fs as any, this.colPath);
    return rxCollectionData(colRef, { idField: 'id' }) as Observable<Problem[]>;
  }

  // 作成
  async create(p: Partial<Problem>) {
    const colRef = nativeCollection(this.fs as any, this.colPath);
    return nativeAddDoc(colRef, {
      title: p.title ?? 'Untitled',
      description: p.description ?? '',
      status: p.status ?? 'not_started',
      progress: p.progress ?? 0,
      tags: p.tags ?? [],
      assignees: p.assignees ?? [],
      order: p.order ?? 0,
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
