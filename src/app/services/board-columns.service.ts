import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { collection as nativeCollection, query as nativeQuery, orderBy as nativeOrderBy } from 'firebase/firestore';
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

  list(projectId: string): Observable<BoardColumn[]> {
    if (!projectId) {
      return of(DEFAULT_BOARD_COLUMNS);
    }

    const colRef = nativeCollection(this.fs as any, this.colPath(projectId));
    const q = nativeQuery(colRef, nativeOrderBy('order', 'asc'));

    return (rxCollectionData(q as any) as Observable<any[]>).pipe(
      map((raw) => {
        const normalized = normalizeColumns(raw ?? []);
        return normalized.length ? normalized : DEFAULT_BOARD_COLUMNS;
      }),
      catchError((err) => {
        console.warn('[BoardColumnsService] Failed to load columns, fallback to default', err);
        return of(DEFAULT_BOARD_COLUMNS);
      })
    );
  }
}
