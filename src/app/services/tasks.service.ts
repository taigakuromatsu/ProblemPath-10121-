import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { Task } from '../models/types';

// 読み取りは rxfire、CRUD は Firebase SDK (native)
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
export class TasksService {
  private readonly base = 'projects/default/problems';

  constructor(private fs: Firestore) {}

  // Issue 配下の Task 一覧（リアルタイム）
  listByIssue(problemId: string, issueId: string): Observable<Task[]> {
    const path = `${this.base}/${problemId}/issues/${issueId}/tasks`;
    const colRef = nativeCollection(this.fs as any, path);
    return rxCollectionData(colRef, { idField: 'id' }) as Observable<Task[]>;
  }

  // 作成
  async create(problemId: string, issueId: string, t: Partial<Task>) {
    const colRef = nativeCollection(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks`);
    return nativeAddDoc(colRef, {
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
    const ref = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks/${id}`);
    return nativeUpdateDoc(ref, { ...patch, updatedAt: serverTimestamp() });
  }

  // 削除
  async remove(problemId: string, issueId: string, id: string) {
    const ref = nativeDoc(this.fs as any, `${this.base}/${problemId}/issues/${issueId}/tasks/${id}`);
    return nativeDeleteDoc(ref);
  }
}

