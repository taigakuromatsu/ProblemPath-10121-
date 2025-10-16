import { Injectable } from '@angular/core';
import { Firestore, collection, doc, addDoc, updateDoc, deleteDoc, collectionData } from '@angular/fire/firestore';
import { serverTimestamp } from 'firebase/firestore';
import { Observable } from 'rxjs';
import { Problem } from '../models/types';

@Injectable({ providedIn: 'root' })
export class ProblemsService {
  // まずはプロジェクト固定で走る（後で切替UIを作る）
  private readonly colPath = 'projects/default/problems';

  constructor(private fs: Firestore) {}

  // 一覧（リアルタイム購読）
  list(): Observable<Problem[]> {
    const colRef = collection(this.fs, this.colPath);
    return collectionData(colRef, { idField: 'id' }) as Observable<Problem[]>;
  }

  // 作成
  async create(p: Partial<Problem>) {
    const colRef = collection(this.fs, this.colPath);
    const docRef = await addDoc(colRef, {
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
    console.log('[ProblemsService.create] path =', docRef.path);
    return docRef;
  }  

  // 更新
  async update(id: string, patch: Partial<Problem>) {
    const docRef = doc(this.fs, `${this.colPath}/${id}`);
    return updateDoc(docRef, { ...patch, updatedAt: serverTimestamp() });
  }

  // 削除
  async remove(id: string) {
    const docRef = doc(this.fs, `${this.colPath}/${id}`);
    return deleteDoc(docRef);
  }
}
