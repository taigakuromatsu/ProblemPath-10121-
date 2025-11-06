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
  // ▼ 追加（メール/パスワード & プロフィール更新）
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  updateProfile,
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

  /** email から表示名を推定（先頭のローカル部を整形） */
  private deriveDisplayName(email?: string | null): string | null {
    if (!email) return null;
    const local = email.split('@')[0] ?? '';
    const name = local.replace(/[._-]+/g, ' ').trim();
    return name || null;
  }

  constructor() {
    // 1) リダイレクト結果を回収
    getRedirectResult(this.auth)
      .then(async (cred) => {
        if (cred?.user) {
          let name = cred.user.displayName ?? this.deriveDisplayName(cred.user.email) ?? 'Me';
          if (!cred.user.displayName && name) {
            try { await updateProfile(cred.user, { displayName: name }); } catch {}
          }
          console.debug('[auth] redirect result user=', cred.user.uid);
          await this.ensureOnboard(cred.user.uid, name);
        } else {
          console.debug('[auth] redirect result: none');
        }
      })
      .catch((e) => {
        console.warn('[auth] getRedirectResult error:', e?.code || e);
      });

    // 2) onAuthStateChanged（保険）
    onAuthStateChanged(this.auth, async (u) => {
      console.debug('[auth] onAuthStateChanged =>', !!u, u?.uid);
      if (!u || this.didOnboard) return;
      this.didOnboard = true;
      let name = u.displayName ?? this.deriveDisplayName(u.email) ?? 'Me';
      if (!u.displayName && name) {
        try { await updateProfile(u, { displayName: name }); } catch {}
      }
      await this.ensureOnboard(u.uid, name);
    });
  }

  /** Google サインイン */
  async signInWithGoogle(opts: { forceChoose?: boolean } = {}): Promise<void> {
    const provider = new GoogleAuthProvider();
    if (opts.forceChoose) provider.setCustomParameters({ prompt: 'select_account' });

    await setPersistence(this.auth as any, browserLocalPersistence);

    try {
      await signInWithPopup(this.auth, provider);
    } catch (e: any) {
      const code = e?.code as string | undefined;
      const shouldFallback =
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/operation-not-supported-in-this-environment' ||
        code === 'auth/unauthorized-domain';

      if (shouldFallback) {
        await signInWithRedirect(this.auth, provider);
        return;
      }
      throw e;
    }
  }

  // ===== メール/パスワード導線（追加） =====

  /** 新規登録（メール/パスワード） */
  async signUpWithEmail(email: string, password: string) {
    await setPersistence(this.auth as any, browserLocalPersistence);
    const { user } = await createUserWithEmailAndPassword(this.auth, email, password);
    // 表示名が空なら email から自動セット
    const name = this.deriveDisplayName(user.email) ?? 'Me';
    try { await updateProfile(user, { displayName: name }); } catch {}
  }

  /** サインイン（メール/パスワード） */
  async signInWithEmail(email: string, password: string) {
    await setPersistence(this.auth as any, browserLocalPersistence);
    await signInWithEmailAndPassword(this.auth, email, password);
  }

  /** パスワードリセット */
  resetPassword(email: string) {
    return sendPasswordResetEmail(this.auth, email);
  }

  /** 自分の表示名を変更（プロフィール＆メンバー同期用） */
  async updateMyDisplayName(newName: string) {
    const u = this.auth.currentUser;
    if (!u) return;
    await updateProfile(u, { displayName: newName });
    // 以降は各画面側で members/{uid}.displayName を必要に応じて同期更新してください
  }

  private _isSigningOut = false;
  get isSigningOut(): boolean {
    return this._isSigningOut;
  }

  /** サインアウト */
  async signOut(): Promise<void> {
    this._isSigningOut = true;
    try {
      this.currentProject.set(null);
      await signOut(this.auth);
      this.didOnboard = false;
    } finally {
      // 成功・失敗どちらでも必ず false に戻す
      this._isSigningOut = false;
    }
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




