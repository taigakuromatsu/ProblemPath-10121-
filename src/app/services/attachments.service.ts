// src/app/services/attachments.service.ts
import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Storage } from '@angular/fire/storage';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';

// Firestore (native) + rxfire
import {
  collection as nativeCollection,
  addDoc as nativeAddDoc,
  deleteDoc as nativeDeleteDoc,
  doc as nativeDoc,
  serverTimestamp,
  query as nativeQuery,
  orderBy as nativeOrderBy,
} from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';

import {
  ref as sRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from 'firebase/storage';

export type AttachmentTarget =
  | { kind:'problem'; projectId:string; problemId:string; }
  | { kind:'issue';   projectId:string; problemId:string; issueId:string; }
  | { kind:'task';    projectId:string; problemId:string; issueId:string; taskId:string; };

export interface AttachmentDoc {
  id?: string;
  name: string;
  contentType: string;
  size: number;
  storagePath: string;
  downloadURL?: string|null;
  createdBy: string;
  createdAt: any;
  updatedAt: any;
  note?: string|null;
  tags?: string[];
  softDeleted?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AttachmentsService {
  constructor(private fs: Firestore, private storage: Storage) {}

  // --- パス計算（Firestore / Storage 共通のベース）
  private colPath(t: AttachmentTarget): string {
    if (t.kind === 'problem') return `projects/${t.projectId}/problems/${t.problemId}/attachments`;
    if (t.kind === 'issue')   return `projects/${t.projectId}/problems/${t.problemId}/issues/${t.issueId}/attachments`;
    return `projects/${t.projectId}/problems/${t.problemId}/issues/${t.issueId}/tasks/${t.taskId}/attachments`;
  }
  private storageBase(t: AttachmentTarget): string {
    if (t.kind === 'problem') return `projects/${t.projectId}/problems/${t.problemId}/attachments`;
    if (t.kind === 'issue')   return `projects/${t.projectId}/problems/${t.problemId}/issues/${t.issueId}/attachments`;
    return `projects/${t.projectId}/problems/${t.problemId}/issues/${t.issueId}/tasks/${t.taskId}/attachments`;
  }

  // --- 一覧（リアルタイム）
  list$(t: AttachmentTarget): Observable<AttachmentDoc[]> {
    const colRef = nativeCollection(this.fs as any, this.colPath(t));
    const q = nativeQuery(colRef, nativeOrderBy('createdAt', 'desc'));
    return rxCollectionData(q, { idField: 'id' }).pipe(
      map(d => d as AttachmentDoc[]),
      catchError(err => {
        console.warn('[AttachmentsService.list$]', t, err);
        return of([] as AttachmentDoc[]);
      })
    );
  }

  // --- 一覧（リアルタイム）- Promise版（互換性のため残す）
  list(t: AttachmentTarget): Observable<AttachmentDoc[]> {
    return this.list$(t);
  }

  // --- アップロード + メタ作成（進捗コールバック任意）
  async upload(
    t: AttachmentTarget,
    file: File,
    createdBy: string,
    onProgress?: (pct: number) => void
  ): Promise<AttachmentDoc> {
    const stamp = Date.now();
    const safeName = file.name.replace(/[^\w.\-()]/g, '_');
    const storagePath = `${this.storageBase(t)}/${stamp}_${safeName}`;

    const storageRef = sRef(this.storage, storagePath);
    const task = uploadBytesResumable(storageRef, file, {
      contentType: file.type || 'application/octet-stream',
      customMetadata: {
        createdBy,
      },
    });

    // 進捗＆エラーログ
    await new Promise<void>((resolve, reject) => {
      task.on(
        'state_changed',
        (s) => {
          if (onProgress) {
            const pct = Math.round((s.bytesTransferred / s.totalBytes) * 100);
            onProgress(pct);
          }
        },
        (e: any) => {
          console.error('[storage upload error]', {
            code: e?.code,
            message: e?.message,
            serverResponse: e?.serverResponse,
            path: storagePath
          });
          reject(e);
        },
        () => resolve()
      );
    });

    // ★ downloadURL を必ず取得（失敗したら Firestore には書かない）
    let url: string;
    try {
      url = await getDownloadURL(storageRef);
    } catch (e: any) {
      console.error('[getDownloadURL error] Firestore へのメタ書き込みを中止します', {
        code: e?.code,
        message: e?.message,
        path: storagePath
      });
      throw e;
    }

    // ★ ルールに合うフィールドのみ
    const meta: Omit<AttachmentDoc, 'id'> = {
      name: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      storagePath,
      downloadURL: url, // 空でない文字列
      createdBy,
      createdAt: serverTimestamp() as any,
      updatedAt: serverTimestamp() as any,
      // softDeleted は書かない（ルールに合わせる）
    };

    const colRef = nativeCollection(this.fs as any, this.colPath(t));
    const ref = await nativeAddDoc(colRef, meta as any);
    return { ...meta, id: ref.id };
  }

  // --- 削除（Storage→メタの順で削除。失敗しても片側は進める）
  async remove(t: AttachmentTarget, id: string, storagePath: string): Promise<void> {
    try { await deleteObject(sRef(this.storage, storagePath)); } catch (e) {
      console.warn('[storage delete warning]', e);
    }
    const ref = nativeDoc(this.fs as any, `${this.colPath(t)}/${id}`);
    await nativeDeleteDoc(ref);
  }
}


