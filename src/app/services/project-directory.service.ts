import { Injectable, inject } from '@angular/core';
import { Firestore, docData } from '@angular/fire/firestore';
import { collection, doc, getDocs, getDoc, query } from 'firebase/firestore';

export type MyProject = { pid: string; name: string; role: 'admin'|'member'|'viewer' };

@Injectable({ providedIn: 'root' })
export class ProjectDirectoryService {
  private fs = inject(Firestore);

  /** 自分が所属するプロジェクト一覧（admin -> member -> viewer の順で並べ替え） */
  async listMine(uid: string): Promise<MyProject[]> {
    const col = collection(this.fs as any, `users/${uid}/memberships`);
    const snap = await getDocs(query(col));
    const roles = new Map<string, MyProject['role']>(
      snap.docs.map(d => [d.id, (d.data() as any).role])
    );

    const items: MyProject[] = [];
    for (const pid of Array.from(roles.keys())) {
      const metaDoc = await getDoc(doc(this.fs as any, `projects/${pid}`));
      const name = metaDoc.exists()
        ? ((metaDoc.data() as any)?.meta?.name ?? '(no name)')
        : '(missing)';
      items.push({ pid, name, role: roles.get(pid)! });
    }

    // 任意: 管理しやすいように admin を先頭に
    const order = { admin: 0, member: 1, viewer: 2 } as const;
    items.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));

    return items;
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
  roleDoc$(pid: string, uid: string) {
    const ref = doc(this.fs as any, `projects/${pid}/members/${uid}`);
    return docData(ref as any) as any; // { role, ... } を購読
  }
}

