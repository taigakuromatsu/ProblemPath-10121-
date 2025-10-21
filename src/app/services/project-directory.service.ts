import { Injectable, inject } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { collection, doc, getDocs, getDoc, query } from 'firebase/firestore';

export type MyProject = { pid: string; name: string; role: 'admin'|'member'|'viewer' };

@Injectable({ providedIn: 'root' })
export class ProjectDirectoryService {
  private fs = inject(Firestore);

  async listMine(uid: string): Promise<MyProject[]> {
    const col = collection(this.fs as any, `users/${uid}/memberships`);
    const snap = await getDocs(query(col));
    const roles = new Map<string, MyProject['role']>(
      snap.docs.map(d => [d.id, (d.data() as any).role])
    );

    const items: MyProject[] = [];
    for (const pid of Array.from(roles.keys())) {
      const metaDoc = await getDoc(doc(this.fs as any, `projects/${pid}`));
      const name = metaDoc.exists() ? ((metaDoc.data() as any)?.meta?.name ?? '(no name)') : '(missing)';
      items.push({ pid, name, role: roles.get(pid)! });
    }
    // 並べ替えはお好みで（admin優先など）
    return items;
  }
}
