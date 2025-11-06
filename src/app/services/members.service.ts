// src/app/services/members.service.ts
import { Injectable, inject } from '@angular/core';
import { Firestore, writeBatch } from '@angular/fire/firestore';
import {
  collection as nativeCollection,
  doc as nativeDoc,
  updateDoc as nativeUpdateDoc,
  deleteDoc as nativeDeleteDoc,
  query as nativeQuery,
  orderBy as nativeOrderBy,
} from 'firebase/firestore';
import { collectionData as rxCollectionData, docData as rxDocData } from 'rxfire/firestore';
import { Observable, of, combineLatest } from 'rxjs';
import { map, switchMap, shareReplay, distinctUntilChanged, catchError } from 'rxjs/operators';

import { CurrentProjectService } from './current-project.service';
import { AuthService } from './auth.service';

export type Role = 'admin' | 'member' | 'viewer';
export type Member = {
  uid: string;
  role: Role;
  displayName?: string;
  email?: string;
  joinedAt?: any;
};

@Injectable({ providedIn: 'root' })
export class MembersService {
  private fs = inject(Firestore);
  private current = inject(CurrentProjectService);
  private auth = inject(AuthService);

  // 自分のロール
  readonly role$: Observable<Role | null>;
  readonly isAdmin$: Observable<boolean>;
  readonly isEditor$: Observable<boolean>;

  constructor() {
    this.role$ = combineLatest([this.current.projectId$, this.auth.uid$]).pipe(
      switchMap(([pid, uid]) => {
        if (!pid || !uid) return of<Role | null>(null);
        const ref = nativeDoc(this.fs as any, `projects/${pid}/members/${uid}`);
        return rxDocData(ref).pipe(
          map((v: any) => (v?.role ?? null) as Role | null),
          catchError(err => {
            console.warn('[MembersService.role$]', { projectId: pid, uid }, err);
            return of<Role | null>(null);
          })
        );
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.isAdmin$ = this.role$.pipe(
      map(r => r === 'admin'),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.isEditor$ = this.role$.pipe(
      map(r => r === 'admin' || r === 'member'),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  /** メンバー一覧（displayName → role → joinedAt 相当の順で見やすく） */
  list$(projectId: string | null): Observable<Member[]> {
    if (!projectId) return of([]);
    const col = nativeCollection(this.fs as any, `projects/${projectId}/members`);
    // Firestoreの安定並びのため role/uid でフォールバック
    const q = nativeQuery(col, nativeOrderBy('displayName'), nativeOrderBy('role'), nativeOrderBy('joinedAt'));
    return rxCollectionData(q, { idField: 'uid' }).pipe(
      map((docs: any[]) =>
        docs.map(d => ({
          uid: d.uid,
          role: (d.role ?? 'viewer') as Role,
          displayName: d.displayName ?? '',
          email: d.email ?? '',
          joinedAt: d.joinedAt,
        }))
      ),
      catchError(err => {
        console.warn('[MembersService.list$]', { projectId }, err);
        return of([]);
      })
    );
  }

    /** ロール変更（adminのみルールで許可済み） */
    async updateRole(projectId: string, targetUid: string, next: Role): Promise<void> {
      // projects 側と users 側を “同一バッチ”で更新して表示と実体のズレを防ぐ
      const b = writeBatch(this.fs as any);
      const projRef = nativeDoc(this.fs as any, `projects/${projectId}/members/${targetUid}`);
      const userRef = nativeDoc(this.fs as any, `users/${targetUid}/memberships/${projectId}`);
  
      // projects 側は必ず存在する想定なので update
      (b as any).update(projRef, { role: next });
  
      // users 側は存在しないケースがあり得るので merge set
      (b as any).set(userRef, { role: next }, { merge: true });
  
      await (b as any).commit();
    }

  /**
   * メンバー削除（admin）
   * - projects/{pid}/members/{uid}
   * - users/{uid}/memberships/{pid} も合わせて削除（ルールで admin 可）
   */
  async removeMembership(projectId: string, targetUid: string): Promise<void> {
    const b = writeBatch(this.fs as any);
    const projRef = nativeDoc(this.fs as any, `projects/${projectId}/members/${targetUid}`);
    const userRef = nativeDoc(this.fs as any, `users/${targetUid}/memberships/${projectId}`);
    b.delete(projRef as any);
    b.delete(userRef as any);
    await b.commit();
  }
}

