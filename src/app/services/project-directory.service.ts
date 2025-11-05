import { Injectable, inject } from '@angular/core';
import { Firestore, docData } from '@angular/fire/firestore';
import { collection, doc, getDocs, getDoc, query } from 'firebase/firestore';
import { collectionData as rxCollectionData, docData as rxDocData } from 'rxfire/firestore';
import { Observable, of, combineLatest } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

export type MyProject = { pid: string; name: string; role: 'admin'|'member'|'viewer' };

@Injectable({ providedIn: 'root' })
export class ProjectDirectoryService {
  private fs = inject(Firestore);

  /** 自分が所属するプロジェクト一覧（admin -> member -> viewer の順で並べ替え） */
  listMine$(uid: string): Observable<MyProject[]> {
    const col = collection(this.fs as any, `users/${uid}/memberships`);
    const q = query(col);
    return rxCollectionData(q, { idField: 'id' }).pipe(
      switchMap(memberships => {
        const roles = new Map<string, MyProject['role']>(
          memberships.map((d: any) => [d.id, d.role])
        );
        const projectIds = Array.from(roles.keys());
        if (projectIds.length === 0) {
          return of([] as MyProject[]);
        }
        // 各プロジェクトのメタデータを取得
        const projectObservables = projectIds.map(pid => {
          const metaRef = doc(this.fs as any, `projects/${pid}`);
          return rxDocData(metaRef).pipe(
            map((metaDoc: any) => {
              const name = metaDoc?.meta?.name ?? '(no name)';
              return { pid, name, role: roles.get(pid)! };
            }),
            catchError(() => {
              return of({ pid, name: '(missing)', role: roles.get(pid)! });
            })
          );
        });
        return combineLatest(projectObservables).pipe(
          map(items => {
            // 任意: 管理しやすいように admin を先頭に
            const order = { admin: 0, member: 1, viewer: 2 } as const;
            items.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
            return items;
          })
        );
      }),
      catchError(err => {
        console.warn('[ProjectDirectoryService.listMine$]', { uid }, err);
        return of([] as MyProject[]);
      })
    );
  }

  /** 退出/削除後のフォールバック用に、ユーザーのいずれか1つのプロジェクトIDを返す（無ければ null） */
  async getAnyProjectIdForUser(uid: string): Promise<string | null> {
    const snap = await getDocs(collection(this.fs as any, `users/${uid}/memberships`));
    return snap.empty ? null : snap.docs[0].id;
  }

  /** UI側から「再読込」を明示したいときに呼べるフック（今はノーオペでOK） */
  refresh(): void {
    // いまはキャッシュしていないので何もしない。
    // 将来キャッシュを入れる場合は、ここで invalidation する。
  }

  /** （必要なら）特定プロジェクトの現在ロールを1回だけ取得したい時に使うユーティリティ */
  async getMyRoleOnce(pid: string, uid: string): Promise<MyProject['role'] | null> {
    const snap = await getDoc(doc(this.fs as any, `projects/${pid}/members/${uid}`));
    return snap.exists() ? ((snap.data() as any).role as MyProject['role']) : null;
  }

  /** （オプション）リアルタイムでロールを追従したい場合に使う Observable 版 */
  roleDoc$(pid: string, uid: string): Observable<{ role?: MyProject['role'] } | null> {
    const ref = doc(this.fs as any, `projects/${pid}/members/${uid}`);
    return rxDocData(ref).pipe(
      map((v: any) => v ? { role: v.role } : null),
      catchError(err => {
        console.warn('[ProjectDirectoryService.roleDoc$]', { projectId: pid, uid }, err);
        return of(null);
      })
    );
  }
}

