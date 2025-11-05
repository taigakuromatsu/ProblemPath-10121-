import { Injectable, inject } from '@angular/core';
import {
  Auth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signOut,
  user as afUser,
} from '@angular/fire/auth';
import { map, shareReplay } from 'rxjs/operators';
import { Observable } from 'rxjs';

import { Firestore } from '@angular/fire/firestore';
import { addDoc, collection, doc, setDoc, serverTimestamp, getDocs, limit, query } from 'firebase/firestore';

import { CurrentProjectService } from './current-project.service';

// 永続化は firebase/auth から（AngularFire でも可だが raw を使う方が確実）
import { setPersistence, browserLocalPersistence } from 'firebase/auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(Auth);
  private fs   = inject(Firestore);
  private currentProject = inject(CurrentProjectService);

  /** Firebase Auth user$ */
  readonly user$ = afUser(this.auth).pipe(shareReplay({ bufferSize: 1, refCount: true }));
  readonly loggedIn$: Observable<boolean> = this.user$.pipe(map(u => !!u));
  readonly uid$: Observable<string | null> = this.user$.pipe(map(u => u?.uid ?? null));
  readonly displayName$: Observable<string | null> = this.user$.pipe(map(u => u?.displayName ?? null));

  private didOnboard = false;

  constructor() {
    // 1) リダイレクト結果を“必ず”回収（成功時はここで currentUser も立つ）
    getRedirectResult(this.auth)
      .then(async (cred) => {
        if (cred?.user) {
          // デバッグログ（必要に応じて消してOK）
          console.debug('[auth] redirect result user=', cred.user.uid);
          await this.ensureOnboard(cred.user.uid, cred.user.displayName || 'Me');
        } else {
          console.debug('[auth] redirect result: none');
        }
      })
      .catch((e) => {
        console.warn('[auth] getRedirectResult error:', e?.code || e);
      });

    // 2) onAuthStateChanged でも保険（ブラウザや拡張の差異対策）
    onAuthStateChanged(this.auth, async (u) => {
      console.debug('[auth] onAuthStateChanged =>', !!u, u?.uid);
      if (!u || this.didOnboard) return;
      this.didOnboard = true;
      await this.ensureOnboard(u.uid, u.displayName || 'Me');
    });
  }

  /**
   * Google サインイン
   * - まず Popup を試し、ブロック/未対応などの代表的エラーは Redirect にフォールバック
   * - 選択毎回表示したい場合は { forceChoose: true }
   */
  async signInWithGoogle(opts: { forceChoose?: boolean } = {}): Promise<void> {
    const provider = new GoogleAuthProvider();
    if (opts.forceChoose) provider.setCustomParameters({ prompt: 'select_account' });

    // 永続化は明示（initializeAuth 側でも設定しているが二重指定は安全側）
    await setPersistence(this.auth as any, browserLocalPersistence);

    try {
      await signInWithPopup(this.auth, provider);
      // Popup 成功時はここで onAuthStateChanged が走る
    } catch (e: any) {
      const code = e?.code as string | undefined;
      const shouldFallback =
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/operation-not-supported-in-this-environment' ||
        code === 'auth/unauthorized-domain';

      if (shouldFallback) {
        // フォールバック：Redirect
        await signInWithRedirect(this.auth, provider);
        return;
      }
      throw e;
    }
  }

  /** サインアウト */
  async signOut(): Promise<void> {
    this.currentProject.set(null);
    await signOut(this.auth);
    this.didOnboard = false;
  }

  // ---- 初回ログイン時の自動作成 / 既存ユーザーは前回 or 最初のプロジェクトを選択 ----
  private async ensureOnboard(uid: string, displayName: string) {
    const persisted = localStorage.getItem('pp.currentProjectId');
    if (persisted) { this.currentProject.set(persisted); return; }

    const membershipsCol = collection(this.fs as any, `users/${uid}/memberships`);
    const snap = await getDocs(query(membershipsCol, limit(1)));
    if (!snap.empty) {
      const firstId = snap.docs[0].id;
      this.currentProject.set(firstId);
      return;
    }

    const projectsCol = collection(this.fs as any, 'projects');
    const projDoc = await addDoc(projectsCol, {
      meta: { name: `${displayName} Project`, createdBy: uid, createdAt: serverTimestamp() }
    });
    const projectId = projDoc.id;

    await setDoc(doc(this.fs as any, `projects/${projectId}/members/${uid}`), {
      role: 'admin',
      joinedAt: serverTimestamp(),
      displayName,
      email: (this as any).auth.currentUser?.email ?? null,
    }, { merge: true });

    await setDoc(doc(this.fs as any, `users/${uid}/memberships/${projectId}`), {
      role: 'admin',
      joinedAt: serverTimestamp(),
    });

    this.currentProject.set(projectId);
  }
}



