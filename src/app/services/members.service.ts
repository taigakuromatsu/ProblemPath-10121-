// members.service.ts
import { Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { doc as nativeDoc } from 'firebase/firestore';
import { docData as rxDocData } from 'rxfire/firestore';
import { Observable, of, combineLatest } from 'rxjs';
import { map, switchMap, shareReplay, distinctUntilChanged } from 'rxjs/operators';

import { CurrentProjectService } from './current-project.service';
import { AuthService } from './auth.service';

export type Role = 'admin' | 'member' | 'viewer';

@Injectable({ providedIn: 'root' })
export class MembersService {
  // フィールドは「型だけ」宣言
  readonly role$!: Observable<Role | null>;
  readonly isAdmin$!: Observable<boolean>;
  readonly isEditor$!: Observable<boolean>;

  constructor(
    private fs: Firestore,
    private current: CurrentProjectService,
    private auth: AuthService
  ) {
    // ここで代入（＝初期化順の警告を回避）
    this.role$ = combineLatest([this.current.projectId$, this.auth.uid$]).pipe(
      switchMap(([pid, uid]) => {
        if (!pid || !uid) return of<Role | null>(null);
        const ref = nativeDoc(this.fs as any, `projects/${pid}/members/${uid}`);
        return rxDocData(ref as any).pipe(
          map((v: any) => (v?.role ?? null) as Role | null)
        );
      }),
      distinctUntilChanged((a, b) => a === b),
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
}
