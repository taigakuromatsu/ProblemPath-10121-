import { Injectable, inject } from '@angular/core';
import { Firestore, doc, docData, setDoc } from '@angular/fire/firestore';
import { BehaviorSubject, Observable, of, firstValueFrom } from 'rxjs';
import { switchMap, map, catchError } from 'rxjs/operators';
import { AuthService } from './auth.service';

export type DueReminderMode = 'none' | '1d' | '7d' | '1d7d';

export interface NotifyPrefs {
  instantComment?: boolean;
  instantFile?: boolean;
  dueReminderMode?: DueReminderMode;
  dueReminderHour?: number;
}

const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  instantComment: true,
  instantFile: true,
  dueReminderMode: '1d7d',
  dueReminderHour: 9,
};

// 1ユーザー1ドキュメントで管理（users/{uid}/notifyPrefs/app）
const PREF_DOC_ID = 'app';

@Injectable({ providedIn: 'root' })
export class NotifyPrefsService {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);

  private readonly state = new BehaviorSubject<NotifyPrefs | null>(null);
  readonly prefs$: Observable<NotifyPrefs | null> = this.state.asObservable();

  constructor() {
    this.auth.uid$
      .pipe(
        switchMap(uid => {
          if (!uid) {
            return of(null);
          }

          // ✅ 偶数セグメントに修正
          const ref = doc(this.firestore as any, `users/${uid}/notifyPrefs/${PREF_DOC_ID}`);

          return docData(ref).pipe(
            map((raw: any) => ({
              ...DEFAULT_NOTIFY_PREFS,
              ...(raw || {}),
            }) as NotifyPrefs),
            catchError(() => of(DEFAULT_NOTIFY_PREFS as NotifyPrefs))
          );
        })
      )
      .subscribe(prefs => {
        this.state.next(prefs);
      });
  }

  async update(patch: Partial<NotifyPrefs>): Promise<void> {
    const uid = await firstValueFrom(this.auth.uid$);
    if (!uid) return;

    const current = this.state.value ?? DEFAULT_NOTIFY_PREFS;
    const next: NotifyPrefs = { ...current, ...patch };

    // ✅ 書き込み側も同じパスに統一
    const ref = doc(this.firestore as any, `users/${uid}/notifyPrefs/${PREF_DOC_ID}`);
    await setDoc(ref, next, { merge: true });

    this.state.next(next);
  }
}

