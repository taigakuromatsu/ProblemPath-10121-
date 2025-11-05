// src/app/services/board-columns.service.ts
import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import {
  collection as nativeCollection,
  deleteDoc as nativeDeleteDoc,
  doc as nativeDoc,
  setDoc as nativeSetDoc,
} from 'firebase/firestore';
import { collectionData as rxCollectionData } from 'rxfire/firestore';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { BoardColumn, DEFAULT_BOARD_COLUMNS, normalizeColumns } from '../models/types';

@Injectable({ providedIn: 'root' })
export class BoardColumnsService {
  constructor(private fs: Firestore) {}

  private colPath(projectId: string) {
    if (!projectId) {
      throw new Error('[BoardColumnsService] projectId is required');
    }
    return `projects/${projectId}/boardColumns`;
  }

  /**
   * カンバン列の定義を読む。
   * 以前は orderBy('order') で取得していたけど、
   * Firestore のドキュメントに order が入っていない場合はヒット0件になってしまう。
   * → なのでまず素で全件取得して、sortは normalizeColumns() 側に任せる。
   */
  list$(projectId: string): Observable<BoardColumn[]> {
    const col = nativeCollection(this.fs as any, this.colPath(projectId));
    return rxCollectionData(col, { idField: 'id' }).pipe(
      map(d => {
        const normalized = normalizeColumns(d ?? []);
        return normalized.length ? normalized : DEFAULT_BOARD_COLUMNS;
      }),
      catchError(err => {
        console.warn('[BoardColumnsService.list$]', { projectId }, err);
        return of(DEFAULT_BOARD_COLUMNS);
      })
    );
  }

  /**
   * 列の編集結果を保存する。
   * 既存ドキュメントがなくても merge:true で作成される。
   * 'order' はここでは書かない（必須じゃない）。
   * Firestore rules 側も「存在するキーだけチェックする」形にしてあるのでOK。
   */
  async updateColumn(
    projectId: string,
    columnId: string,
    patch: {
      title?: string;
      categoryHint?: 'not_started' | 'in_progress' | 'done';
      progressHint?: number;
      order?: number;
    }
  ): Promise<void> {
    if (!projectId) {
      throw new Error('[BoardColumnsService] projectId is required');
    }
    if (!columnId) {
      throw new Error('[BoardColumnsService] columnId is required');
    }

    const ref = nativeDoc(this.fs as any, `${this.colPath(projectId)}/${columnId}`);

    // Firestoreに保存するデータ
    // columnId はドキュメント本体にも入れておく（ルール側で許可されているし、後で参照しやすい）
    const data: Record<string, unknown> = { columnId };

    (['title', 'categoryHint', 'progressHint', 'order'] as const).forEach((key) => {
      const value = patch[key];
      if (value !== undefined) {
        data[key] = value;
      }
    });

    await nativeSetDoc(ref as any, data, { merge: true });
  }

  async createColumn(projectId: string, column: BoardColumn): Promise<void> {
    if (!projectId) {
      throw new Error('[BoardColumnsService] projectId is required');
    }
    if (!column?.columnId) {
      throw new Error('[BoardColumnsService] columnId is required');
    }

    const ref = nativeDoc(this.fs as any, `${this.colPath(projectId)}/${column.columnId}`);
    await nativeSetDoc(
      ref as any,
      {
        columnId: column.columnId,
        title: column.title,
        order: column.order,
        categoryHint: column.categoryHint,
        progressHint: column.progressHint,
      },
      { merge: true }
    );
  }

  async deleteColumn(projectId: string, columnId: string): Promise<void> {
    if (!projectId) {
      throw new Error('[BoardColumnsService] projectId is required');
    }
    if (!columnId) {
      throw new Error('[BoardColumnsService] columnId is required');
    }

    const ref = nativeDoc(this.fs as any, `${this.colPath(projectId)}/${columnId}`);
    await nativeDeleteDoc(ref as any);
  }

  private async seedDefaultColumns(projectId: string): Promise<void> {
    const writes = DEFAULT_BOARD_COLUMNS.map((col, idx) => {
      const ref = nativeDoc(this.fs as any, `${this.colPath(projectId)}/${col.columnId}`);
      return nativeSetDoc(
        ref as any,
        {
          columnId: col.columnId,
          title: col.title,
          order: col.order ?? idx,
          categoryHint: col.categoryHint,
          progressHint: col.progressHint,
        },
        { merge: true }
      );
    });
    await Promise.all(writes);
  }
}
