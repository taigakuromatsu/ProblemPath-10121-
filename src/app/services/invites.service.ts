import { Injectable, inject } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { doc as nativeDoc } from 'firebase/firestore';
import { docData as rxDocData } from 'rxfire/firestore';
import { Observable, of } from 'rxjs';
import { map, catchError, take } from 'rxjs/operators';

export type InviteRole = 'admin'|'member'|'viewer';

@Injectable({ providedIn: 'root' })
export class InvitesService {
  private fs = inject(Firestore);

  private randomToken(len = 32): string {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  /** 招待を作成（Admin専用）→ 招待URLを返す */
  async create(projectId: string, email: string, role: InviteRole) {
    const token = this.randomToken(24); // ドキュメントID = トークン
    const ref = doc(this.fs as any, `projects/${projectId}/invites/${token}`);
    await setDoc(ref, {
      email,
      role,
      createdAt: serverTimestamp(),
      createdBy: null, // （必要ならUIDを入れてもOK）
      redeemedBy: null,
      redeemedAt: null,
    });
    const origin = window.location.origin;
    return `${origin}/join?pid=${encodeURIComponent(projectId)}&token=${encodeURIComponent(token)}`;
  }

  /** 招待の検証（存在チェック）- Observable版 */
  get$(projectId: string, token: string): Observable<{ id: string; email: string; role: InviteRole; createdAt: any } | null> {
    const ref = nativeDoc(this.fs as any, `projects/${projectId}/invites/${token}`);
    return rxDocData(ref).pipe(
      take(1),
      map((data: any) => {
        if (!data) return null;
        if (data.redeemedBy) return null; // 使用済み扱い
        return { id: token, ...data };
      }),
      catchError(err => {
        console.warn('[InvitesService.get$]', { projectId, token }, err);
        return of(null);
      })
    );
  }

  /** 招待の検証（存在チェック）- Promise版（互換性のため残す） */
  async get(projectId: string, token: string) {
    const ref = doc(this.fs as any, `projects/${projectId}/invites/${token}`);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data() as any;
    if (data.redeemedBy) return null; // 使用済み扱い
    return { id: token, ...data };
  }

  /** 使用済みにマーキング（お好みで削除でもOK） */
  async markRedeemed(projectId: string, token: string, uid: string) {
    // シンプルに削除派
    const ref = doc(this.fs as any, `projects/${projectId}/invites/${token}`);
    await setDoc(ref, { redeemedBy: uid, redeemedAt: serverTimestamp() }, { merge: true });
  }
}
