// auth.service.ts
import { Injectable, inject } from '@angular/core';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut, user as afUser } from '@angular/fire/auth';
import { map, shareReplay } from 'rxjs/operators';
import { Observable, firstValueFrom } from 'rxjs';

import { Firestore } from '@angular/fire/firestore';
import {
  addDoc, collection, doc, setDoc, serverTimestamp, getDocs, limit, query
} from 'firebase/firestore';

import { CurrentProjectService } from './current-project.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(Auth);
  private fs   = inject(Firestore);
  private currentProject = inject(CurrentProjectService);

  /** Firebase Auth のユーザー（未ログインは null） */
  readonly user$ = afUser(this.auth).pipe(shareReplay({ bufferSize: 1, refCount: true }));

  /** ログイン済みかどうか */
  readonly loggedIn$: Observable<boolean> = this.user$.pipe(map(u => !!u));

  /** UID（未ログイン時は null） */
  readonly uid$: Observable<string | null> = this.user$.pipe(map(u => u?.uid ?? null));

  /** 表示名（未ログイン時は null） */
  readonly displayName$: Observable<string | null> = this.user$.pipe(map(u => u?.displayName ?? null));

// services/auth.service.ts
async signInWithGoogle(forceChoose = false): Promise<void> {
    const provider = new GoogleAuthProvider();
    if (forceChoose) {
      // アカウント選択を毎回表示
      provider.setCustomParameters({ prompt: 'select_account' });
    }
    await signInWithPopup(this.auth, provider);
    const u = this.auth.currentUser;
    if (u) await this.ensureOnboard(u.uid, u.displayName || 'Me');
  }
  

  /** サインアウト */
  async signOut(): Promise<void> {
    this.currentProject.set(null);
    await signOut(this.auth);
  }

  // ---- 初回ログイン時の自動作成 / 既存ユーザーは前回 or 最初のプロジェクトを選択 ----
  private async ensureOnboard(uid: string, displayName: string) {
    // 1) すでに localStorage に選択があれば尊重（members 確認は省略・必要なら exists で厳密化）
    const persisted = localStorage.getItem('pp.currentProjectId');
    if (persisted) {
      this.currentProject.set(persisted);
      return;
    }

    // 2) 自分の memberships を見て、あれば最初の1つを選択
    const membershipsCol = collection(this.fs as any, `users/${uid}/memberships`);
    const snap = await getDocs(query(membershipsCol, limit(1)));
    if (!snap.empty) {
      const firstId = snap.docs[0].id;
      this.currentProject.set(firstId);
      return;
    }

    // 3) 無ければ新規プロジェクトを自動作成（自分を admin で members に追加）
    const projectsCol = collection(this.fs as any, 'projects');
    const projDoc = await addDoc(projectsCol, {
      meta: {
        name: `${displayName} Project`,
        createdBy: uid,
        createdAt: serverTimestamp(),
      }
    });
    const projectId = projDoc.id;

    // members/{uid}
    await setDoc(doc(this.fs as any, `projects/${projectId}/members/${uid}`), {
        role: 'admin',
        joinedAt: serverTimestamp(),
        displayName: displayName,
        email: this.auth.currentUser?.email ?? null,
      }, { merge: true });

    // users/{uid}/memberships/{projectId}
    await setDoc(doc(this.fs as any, `users/${uid}/memberships/${projectId}`), {
      role: 'admin',
      joinedAt: serverTimestamp(),
    });

    // 現在プロジェクトに設定
    this.currentProject.set(projectId);
  }

}
