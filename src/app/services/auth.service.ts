import { Injectable, inject } from '@angular/core';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut, user as afUser } from '@angular/fire/auth';
import { map, shareReplay } from 'rxjs/operators';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(Auth);

  /** Firebase Auth のユーザー（未ログインは null） */
  readonly user$ = afUser(this.auth).pipe(shareReplay({ bufferSize: 1, refCount: true }));

  /** ログイン済みかどうか */
  readonly loggedIn$: Observable<boolean> = this.user$.pipe(map(u => !!u));

  /** UID（未ログイン時は null） */
  readonly uid$: Observable<string | null> = this.user$.pipe(map(u => u?.uid ?? null));

  /** 表示名（未ログイン時は null） */
  readonly displayName$: Observable<string | null> = this.user$.pipe(map(u => u?.displayName ?? null));

  /** プロバイダ：Google でサインイン */
  async signInWithGoogle(): Promise<void> {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(this.auth, provider);
  }

  /** サインアウト */
  async signOut(): Promise<void> {
    await signOut(this.auth);
  }
}
