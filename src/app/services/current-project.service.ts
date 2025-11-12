// src/app/services/current-project.service.ts
import { Injectable, inject } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { collection, doc, getDoc, getDocs, limit, query } from 'firebase/firestore';
import { BehaviorSubject } from 'rxjs';

const LEGACY_KEY = 'pp.currentProjectId';
const keyOf = (uid: string) => `pp.currentProjectId:${uid}`;

@Injectable({ providedIn: 'root' })
export class CurrentProjectService {
  private fs = inject(Firestore);

  // 単一の情報源
  private projectIdSub = new BehaviorSubject<string | null>(null);
  readonly projectId$ = this.projectIdSub.asObservable();

  // 初期確定の完了を合図
  private readySub = new BehaviorSubject<boolean>(false);
  readonly ready$ = this.readySub.asObservable();

  getSync(): string | null { return this.projectIdSub.value; }

  /** 後方互換: 旧 set(id) も受け付ける。uid を渡すとユーザー別キーに保存 */
  set(id: string | null): void;
  set(id: string | null, uid?: string): void;
  set(id: string | null, uid?: string) {
    this.projectIdSub.next(id);

    if (uid) {
      const k = keyOf(uid);
      if (id) localStorage.setItem(k, id);
      else    localStorage.removeItem(k);
      // 旧キーの掃除（アカウント跨ぎの原因を排除）
      if (localStorage.getItem(LEGACY_KEY)) localStorage.removeItem(LEGACY_KEY);
    } else {
      // 互換運用（既存コードが uid を渡していない場合でも動く）
      if (id) localStorage.setItem(LEGACY_KEY, id);
      else    localStorage.removeItem(LEGACY_KEY);
    }
  }

  requireId(): string {
    const v = this.projectIdSub.value;
    if (!v) throw new Error('No projectId selected');
    return v;
  }

  /** ログイン直後に一度だけ呼ぶ: 所属検証してから復元 → ready$ を true に */
  async restoreForUser(uid: string): Promise<string | null> {
    this.readySub.next(false);

    const candidate =
      localStorage.getItem(keyOf(uid)) ??
      localStorage.getItem(LEGACY_KEY) ??
      null;

    if (candidate) {
      // 所属しているプロジェクトか検証
      const memRef = doc(this.fs as any, `users/${uid}/memberships/${candidate}`);
      const memSnap = await getDoc(memRef);
      if (memSnap.exists()) {
        this.set(candidate, uid);
        this.readySub.next(true);
        return candidate;
      }
      // 所属していなければ掃除
      localStorage.removeItem(keyOf(uid));
      localStorage.removeItem(LEGACY_KEY);
    }

    // 所属の先頭を採用（ゼロ件なら null）
    const col = collection(this.fs as any, `users/${uid}/memberships`);
    const snap = await getDocs(query(col, limit(1)));
    const pid = snap.empty ? null : snap.docs[0].id;

    this.set(pid, uid);
    this.readySub.next(true);
    return pid;
  }

  /** サインアウト時の掃除用（任意） */
  clear(uid?: string) {
    this.projectIdSub.next(null);
    this.readySub.next(false);
    if (uid) localStorage.removeItem(keyOf(uid));
  }
}
