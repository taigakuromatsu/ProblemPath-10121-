import { Injectable } from '@angular/core';
import { Firestore, collection, doc, addDoc, updateDoc, deleteDoc, collectionData } from '@angular/fire/firestore';
import { serverTimestamp } from 'firebase/firestore';
import { Observable } from 'rxjs';
import { Issue } from '../models/types';

@Injectable({ providedIn: 'root' })
export class IssuesService {
  // プロジェクトはまず固定（後で切替UIを作る）
  private readonly base = 'projects/default/problems';

  constructor(private fs: Firestore) {}

  // 問題（problemId）配下のIssue一覧を購読
  listByProblem(problemId: string): Observable<Issue[]> {
    const colRef = collection(this.fs, `${this.base}/${problemId}/issues`);
    return collectionData(colRef, { idField: 'id' }) as Observable<Issue[]>;
  }

  // 作成
  async create(problemId: string, i: Partial<Issue>) {
    const colRef = collection(this.fs, `${this.base}/${problemId}/issues`);
    return addDoc(colRef, {
      title: i.title ?? 'Untitled Issue',
      description: i.description ?? '',
      status: i.status ?? 'not_started',
      progress: i.progress ?? 0,
      tags: i.tags ?? [],
      assignees: i.assignees ?? [],
      order: i.order ?? 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      links: i.links ?? [],
    });
  }

  // 更新
  async update(problemId: string, id: string, patch: Partial<Issue>) {
    const ref = doc(this.fs, `${this.base}/${problemId}/issues/${id}`);
    return updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
  }

  // 削除
  async remove(problemId: string, id: string) {
    const ref = doc(this.fs, `${this.base}/${problemId}/issues/${id}`);
    return deleteDoc(ref);
  }
}
