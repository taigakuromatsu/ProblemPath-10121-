import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { getCountFromServer } from 'firebase/firestore';
import {
  collection as nativeCollection,
  addDoc as nativeAddDoc,
  updateDoc as nativeUpdateDoc,
  deleteDoc as nativeDeleteDoc,
  doc as nativeDoc,
  serverTimestamp,
  query as nativeQuery,
  orderBy as nativeOrderBy,
  limit as nativeLimit,
  startAfter as nativeStartAfter,
} from 'firebase/firestore';
import {
  collectionData as rxCollectionData,
} from 'rxfire/firestore';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export type CommentTarget =
  | { kind:'problem'; projectId:string; problemId:string; }
  | { kind:'issue';   projectId:string; problemId:string; issueId:string; }
  | { kind:'task';    projectId:string; problemId:string; issueId:string; taskId:string; };

export interface CommentDoc {
  id?: string;
  body: string;
  authorId: string;
  authorName?: string;
  createdAt: any;   // Firestore Timestamp
  updatedAt: any;   // Firestore Timestamp
}

@Injectable({ providedIn: 'root' })
export class CommentsService {
  constructor(private fs: Firestore){}

  private colPath(t: CommentTarget): string {
    if (t.kind === 'problem') return `projects/${t.projectId}/problems/${t.problemId}/comments`;
    if (t.kind === 'issue')   return `projects/${t.projectId}/problems/${t.problemId}/issues/${t.issueId}/comments`;
    return `projects/${t.projectId}/problems/${t.problemId}/issues/${t.issueId}/tasks/${t.taskId}/comments`;
  }

  listByTarget$(t: CommentTarget, pageSize=50, cursor?: any): Observable<CommentDoc[]> {
    const col = nativeCollection(this.fs as any, this.colPath(t));
    const q = cursor
      ? nativeQuery(col, nativeOrderBy('createdAt','asc'), nativeStartAfter(cursor), nativeLimit(pageSize))
      : nativeQuery(col, nativeOrderBy('createdAt','asc'), nativeLimit(pageSize));
    return rxCollectionData(q, { idField: 'id' }).pipe(
      map(d => d as CommentDoc[]),
      catchError(err => {
        console.warn('[CommentsService.listByTarget$]', t, err);
        return of([] as CommentDoc[]);
      })
    );
  }

  async create(t: CommentTarget, body: string, authorId: string, authorName?: string) {
    const colRef = nativeCollection(this.fs as any, this.colPath(t));
    return nativeAddDoc(colRef, {
      body,
      authorId,
      authorName: authorName ?? null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  async update(t: CommentTarget, id: string, body: string) {
    const ref = nativeDoc(this.fs as any, `${this.colPath(t)}/${id}`);
    return nativeUpdateDoc(ref, { body, updatedAt: serverTimestamp() });
  }

  async delete(t: CommentTarget, id: string) {
    const ref = nativeDoc(this.fs as any, `${this.colPath(t)}/${id}`);
    return nativeDeleteDoc(ref);
  }

  async count(t: CommentTarget): Promise<number> {
    const colRef = nativeCollection(this.fs as any, this.colPath(t));
    const q = nativeQuery(colRef); // フィルタ不要、サブコレ全件の件数
    const snap = await getCountFromServer(q as any);
    return snap.data().count || 0;
  }
  
}
