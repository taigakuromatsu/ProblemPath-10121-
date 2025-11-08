import { Injectable, inject } from '@angular/core';
import { Firestore, doc, docData, setDoc } from '@angular/fire/firestore';
import { BehaviorSubject, Observable, of, firstValueFrom } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

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

@Injectable({ providedIn: 'root' })
export class NotifyPrefsService {
  private readonly fs = inject(Firestore);
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

          const ref = doc(this.fs as any, `users/${uid}/notifyPrefs`);
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

    const current = this.state.value || DEFAULT_NOTIFY_PREFS;
    const next: NotifyPrefs = { ...current, ...patch };

    const ref = doc(this.fs as any, `users/${uid}/notifyPrefs`);
    await setDoc(ref, next, { merge: true });
    this.state.next(next);
  }
}
