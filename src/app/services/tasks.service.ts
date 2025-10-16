import { Injectable } from '@angular/core';
import { Firestore, collection, doc, addDoc, updateDoc, deleteDoc, collectionData } from '@angular/fire/firestore';
import { serverTimestamp } from 'firebase/firestore';
import { Observable } from 'rxjs';
import { Task } from '../models/types';

@Injectable({ providedIn: 'root' })
export class TasksService {
  // まずはプロジェクト固定。後で切替UIを載せる。
  private readonly base = 'projects/default/problems';

  constructor(private fs: Firestore) {}

  // Issue（issueId）配下のTask一覧を購読
  listByIssue(problemId: string, issueId: string): Observable<Task[]> {
    const colRef = collection(this.fs, `${this.base}/${problemId}/issues/${issueId}/tasks`);
    return collectionData(colRef, { idField: 'id' }) as Observable<Task[]>;
  }

  // 作成
  async create(problemId: string, issueId: string, t: Partial<Task>) {
    const colRef = collection(this.fs, `${this.base}/${problemId}/issues/${issueId}/tasks`);
    return addDoc(colRef, {
      title: t.title ?? 'Untitled Task',
      description: t.description ?? '',
      status: t.status ?? 'not_started',
      progress: t.progress ?? 0,
      tags: t.tags ?? [],
      assignees: t.assignees ?? [],
      order: t.order ?? 0,
      dueDate: t.dueDate ?? null,
      priority: t.priority ?? 'mid',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      recurrenceRule: t.recurrenceRule ?? null
    });
  }

  // 更新
  async update(problemId: string, issueId: string, id: string, patch: Partial<Task>) {
    const ref = doc(this.fs, `${this.base}/${problemId}/issues/${issueId}/tasks/${id}`);
    return updateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
  }

  // 削除
  async remove(problemId: string, issueId: string, id: string) {
    const ref = doc(this.fs, `${this.base}/${problemId}/issues/${issueId}/tasks/${id}`);
    return deleteDoc(ref);
  }
}
