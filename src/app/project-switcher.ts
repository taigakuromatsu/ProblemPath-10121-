import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';

import { ProjectDirectoryService, MyProject } from './services/project-directory.service';
import { CurrentProjectService } from './services/current-project.service';
import { AuthService } from './services/auth.service';

import { firstValueFrom } from 'rxjs';

// Firestore
import { Firestore } from '@angular/fire/firestore';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, deleteDoc, updateDoc,
  serverTimestamp, query, where, writeBatch
} from 'firebase/firestore';
import { arrayRemove } from 'firebase/firestore';

@Component({
  standalone: true,
  selector: 'pp-project-switcher',
  imports: [CommonModule, FormsModule, MatSelectModule, MatFormFieldModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div style="display:flex; align-items:center; gap:8px;">
      <mat-form-field appearance="outline" style="min-width:240px; margin:0;">
        <mat-label>Project</mat-label>
        <mat-select
          [(ngModel)]="selected"
          (ngModelChange)="onChange($event)"
          [disabled]="loading || !projects.length"
        >
          <mat-option *ngIf="loading" [disabled]="true">Loading...</mat-option>
          <ng-container *ngIf="!loading && projects.length; else noItems">
            <mat-option *ngFor="let p of projects" [value]="p.pid">
              {{ p.name }} — {{ p.role }}
            </mat-option>
          </ng-container>
        </mat-select>
      </mat-form-field>

      <!-- 右側アクション -->
      <button mat-stroked-button (click)="createProject()" [disabled]="creating || loading">
        ＋ 新規作成
      </button>

      <button mat-stroked-button color="warn"
              (click)="deleteProject()"
              [disabled]="deleting || loading || !canDelete">
        🗑️ 削除
      </button>

      <button mat-stroked-button
              (click)="leaveProject()"
              [disabled]="leaving || loading || !canLeave">
        🚪 退出
      </button>
    </div>

    <ng-template #noItems>
      <mat-option [disabled]="true">No projects</mat-option>
    </ng-template>
  `
})
export class ProjectSwitcher {
  projects: MyProject[] = [];
  selected: string | null = null;
  loading = true;

  // ボタンのスピナー用
  creating = false;
  deleting = false;
  leaving  = false;

  constructor(
    private current: CurrentProjectService,
    private dir: ProjectDirectoryService,
    private authSvc: AuthService,
    private fs: Firestore,
    private cdr: ChangeDetectorRef,
  ) {}

  async ngOnInit() {
    const uid = await firstValueFrom(this.authSvc.uid$);
    if (!uid) { this.loading = false; this.cdr.markForCheck(); return; }

    await this.reload(uid);

    const curr = this.current.getSync();
    if (curr && this.projects.some(p => p.pid === curr)) {
      this.selected = curr;
    } else {
      this.selected = this.projects[0]?.pid ?? null;
      this.current.set(this.selected);
    }
    this.cdr.markForCheck();
  }

  onChange(pid: string | null) {
    this.current.set(pid);
    this.cdr.markForCheck();
  }

  // 選択中プロジェクトの自分のロールから権限を判定
  private get selectedRole(): 'admin'|'member'|'viewer'|null {
    return this.projects.find(p => p.pid === this.selected)?.role ?? null;
  }
  get canDelete() { return this.selectedRole === 'admin'; }
  get canLeave()  { return this.selectedRole === 'member' || this.selectedRole === 'viewer'; }

  // 例外に強い reload（permission-denied を拾ってUIを健全化）
  private async reload(uid: string) {
    this.loading = true; this.cdr.markForCheck();
    try {
      try {
        this.projects = await this.dir.listMine(uid);
      } catch (e: any) {
        console.warn('dir.listMine failed, fallback to memberships path', e);
        this.projects = await this.listMineByMemberships(uid);
      }
    } catch (e) {
      console.warn('Both primary and fallback listing failed, set empty list', e);
      this.projects = []; // ← 最後の砦
    } finally {
      if (this.selected && !this.projects.find(p => p.pid === this.selected)) {
        this.selected = null;
        this.current.set(null); // これで他画面の listen も自然に切れる想定
      }
      this.loading = false; this.cdr.markForCheck();
    }
  }
  
  

  // ============== 新規作成（誰でも） ==============
  async createProject() {
    try {
      this.creating = true; this.cdr.markForCheck();
      const u = (this.authSvc as any).auth?.currentUser;
      if (!u) { await this.authSvc.signInWithGoogle(true); return; }

      const name = prompt('新規プロジェクト名を入力してください', `${u.displayName || 'My'} Project`);
      if (!name) return;

      // projects
      const projRef = await addDoc(collection(this.fs as any, 'projects'), {
        meta: { name, createdBy: u.uid, createdAt: serverTimestamp() }
      });
      const pid = projRef.id;

      // members/{uid}（自分をadminで登録）
      await setDoc(doc(this.fs as any, `projects/${pid}/members/${u.uid}`), {
        role: 'admin',
        joinedAt: serverTimestamp(),
        displayName: u.displayName ?? 'User',
        email: u.email ?? null,
      }, { merge: true });

      // users/{uid}/memberships/{pid}
      await setDoc(doc(this.fs as any, `users/${u.uid}/memberships/${pid}`), {
        role: 'admin',
        joinedAt: serverTimestamp(),
      }, { merge: true });

      // 再読込＆選択
      await this.reload(u.uid);
      this.selected = pid;
      this.current.set(pid);
      alert('プロジェクトを作成しました');
    } finally {
      this.creating = false; this.cdr.markForCheck();
    }
  }

  // ============== 共通ユーティリティ ==============
  private async safeDelete(path: string) {
    try {
      await deleteDoc(doc(this.fs as any, path));
      console.log('[DEL] OK', path);
    } catch (e: any) {
      console.error('[DEL] FAIL', path, e?.code, e?.message);
      throw e; // どこで止まったか追えるように再throw
    }
  }

  // ============== カスケード削除（memberships → members → 本体） ==============
  private async deleteProjectCascade(pid: string): Promise<void> {
    // 成員取得
    const membersSnap = await getDocs(collection(this.fs as any, `projects/${pid}/members`));
    const uids = membersSnap.docs.map(d => d.id);

    // バッチ（500制限を考慮して小分け）
    const commits: Promise<void>[] = [];
    let batch = writeBatch(this.fs as any);
    let ops = 0;
    const pushCommit = () => { commits.push(batch.commit()); batch = writeBatch(this.fs as any); ops = 0; };

    // 1) users/*/memberships を先に
    for (const uid of uids) {
      batch.delete(doc(this.fs as any, `users/${uid}/memberships/${pid}`));
      ops++;
      if (ops >= 450) pushCommit();
    }
    // 2) projects/*/members を次に
    for (const uid of uids) {
      batch.delete(doc(this.fs as any, `projects/${pid}/members/${uid}`));
      ops++;
      if (ops >= 450) pushCommit();
    }
    // 3) 最後に projects 本体
    batch.delete(doc(this.fs as any, `projects/${pid}`));
    ops++;
    pushCommit();

    await Promise.all(commits);
  }

  // ============== 削除（Adminのみ） ==============
  async deleteProject() {
    try {
      this.deleting = true; this.cdr.markForCheck();
      const u = (this.authSvc as any).auth?.currentUser;
      const pid = this.selected;
      if (!u || !pid) return;

      // ロール再確認
      const snap = await getDoc(doc(this.fs as any, `projects/${pid}/members/${u.uid}`));
      const myRole = snap.exists() ? (snap.data() as any).role : null;
      if (myRole !== 'admin') { alert('管理者だけが削除できます'); return; }

      if (!confirm('このプロジェクトを完全に削除します。よろしいですか？（元に戻せません）')) return;

      // 0) invites/問題/課題は存在していても OK（本体と members が消えれば参照は切れる）
      //    ただしストレージや外部リソースがあれば別途掃除が必要。
      //    下の2ブロックは「可能なら先に掃除」する任意工程。

      // invites を可能なら削除
      try {
        const invs = await getDocs(collection(this.fs as any, `projects/${pid}/invites`));
        for (const d of invs.docs) { await this.safeDelete(d.ref.path); }
      } catch (e) { console.warn('invites cleanup skipped', e); }

      // problems/issues/tasks を可能なら削除
      try {
        const probs = await getDocs(collection(this.fs as any, `projects/${pid}/problems`));
        for (const p of probs.docs) {
          const issues = await getDocs(collection(this.fs as any, `projects/${pid}/problems/${p.id}/issues`));
          for (const i of issues.docs) {
            const tasks = await getDocs(collection(this.fs as any, `projects/${pid}/problems/${p.id}/issues/${i.id}/tasks`));
            for (const t of tasks.docs) await this.safeDelete(t.ref.path);
            await this.safeDelete(i.ref.path);
          }
          await this.safeDelete(p.ref.path);
        }
      } catch (e) { console.warn('problems cleanup skipped', e); }

      // ★ 最重要：membership → members → projects の順で削除
      await this.deleteProjectCascade(pid);

      // 選択クリア & 再読込
      if (this.selected === pid) {
        this.selected = null;
        this.current.set(null);
      }
      await this.reload(u.uid);
      if (!this.selected) {
        const next = this.projects[0]?.pid ?? null;
        this.selected = next;
        this.current.set(next);
      }
      alert('プロジェクトを削除しました');
    } finally {
      this.deleting = false; this.cdr.markForCheck();
    }
  }

  // ============== 退出（Member/Viewerのみ） ==============
  // 指定プロジェクトで uid が assignees に含まれるタスクを一括 Unassign
  private async unassignAllTasksForUser(pid: string, uid: string) {
    const probs = await getDocs(collection(this.fs as any, `projects/${pid}/problems`));
    for (const p of probs.docs) {
      const issues = await getDocs(collection(this.fs as any, `projects/${pid}/problems/${p.id}/issues`));
      for (const i of issues.docs) {
        const tasks = await getDocs(query(
          collection(this.fs as any, `projects/${pid}/problems/${p.id}/issues/${i.id}/tasks`),
          where('assignees', 'array-contains', uid)
        ));
        for (const t of tasks.docs) {
          await updateDoc(t.ref, { assignees: arrayRemove(uid), updatedAt: serverTimestamp() as any });
        }
      }
    }
  }

  async leaveProject() {
    try {
      this.leaving = true; this.cdr.markForCheck();
      const u = (this.authSvc as any).auth?.currentUser;
      const pid = this.selected;
      if (!u || !pid) return;

      const memberRef = doc(this.fs as any, `projects/${pid}/members/${u.uid}`);
      const snap = await getDoc(memberRef);
      if (!snap.exists()) return;

      const role = (snap.data() as any).role;
      if (role === 'admin') { alert('管理者はここから退出できません'); return; }

      if (!confirm('このプロジェクトから退出します。よろしいですか？\n（担当タスクの割り当ても外れます）')) return;

      // ① 先にタスクから自分を Unassign
      await this.unassignAllTasksForUser(pid, u.uid);

      // ② users/*/memberships を先、③ projects/*/members を後
      await deleteDoc(doc(this.fs as any, `users/${u.uid}/memberships/${pid}`)).catch(() => {});
      await deleteDoc(memberRef).catch(() => {});

      // ④ フォールバック選択
      await this.reload(u.uid);
      const next = this.projects[0]?.pid ?? null;
      this.selected = next;
      this.current.set(next);
      alert('退出しました');
    } finally {
      this.leaving = false; this.cdr.markForCheck();
    }
  }

  private async listMineByMemberships(uid: string): Promise<MyProject[]> {
    // users/{uid}/memberships は rules で本人 read 許可済み
    const ms = await getDocs(collection(this.fs as any, `users/${uid}/memberships`));
  
    const items = await Promise.all(ms.docs.map(async (m) => {
      const pid = m.id;
      const role = (m.data() as any)?.role ?? 'viewer';
      // projects/{pid} は isMember(pid) で許可。自分の members がある間は読める
      const pSnap = await getDoc(doc(this.fs as any, `projects/${pid}`)).catch(() => null);
      const name = pSnap?.exists() ? ((pSnap.data() as any)?.meta?.name ?? '(no name)') : '(deleted)';
      return { pid, name, role } as MyProject;
    }));
  
    // 既に消えた/権限消失のプロジェクトは除外
    return items.filter(p => p.name !== '(deleted)');
  }
  
}



