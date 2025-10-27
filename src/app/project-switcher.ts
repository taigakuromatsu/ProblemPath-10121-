import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';

import { ProjectDirectoryService, MyProject } from './services/project-directory.service';
import { CurrentProjectService } from './services/current-project.service';
import { AuthService } from './services/auth.service';
import { NetworkService } from './services/network.service';

import { firstValueFrom, Observable } from 'rxjs';

// Firestore
import { Firestore } from '@angular/fire/firestore';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, deleteDoc, updateDoc,
  serverTimestamp, query, where, writeBatch, onSnapshot
} from 'firebase/firestore';
import { arrayRemove } from 'firebase/firestore';

@Component({
  standalone: true,
  selector: 'pp-project-switcher',
  imports: [CommonModule, FormsModule, MatSelectModule, MatFormFieldModule, MatButtonModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div style="display:flex; align-items:center; gap:8px;">
      <mat-form-field appearance="outline" style="min-width:240px; margin:0;">
        <mat-label>{{ 'projectSwitcher.project' | translate }}</mat-label>
        <mat-select
          [(ngModel)]="selected"
          (ngModelChange)="onChange($event)"
          [disabled]="loading || !projects.length || !(isOnline$ | async)"
        >
          <mat-option *ngIf="loading" [disabled]="true">{{ 'projectSwitcher.loading' | translate }}</mat-option>
          <ng-container *ngIf="!loading && projects.length; else noItems">
            <mat-option *ngFor="let p of projects" [value]="p.pid">
              {{ p.name }} — {{ ('role.' + p.role + 'Label') | translate }}
            </mat-option>
          </ng-container>
        </mat-select>
      </mat-form-field>

      <!-- 右側アクション（オフライン時は抑止） -->
      <button mat-stroked-button (click)="createProject()"
              [disabled]="creating || loading || !(isOnline$ | async)">
        ＋ {{ 'projectSwitcher.new' | translate }}
      </button>

      <button mat-stroked-button color="warn"
              (click)="deleteProject()"
              [disabled]="deleting || loading || !canDelete || !(isOnline$ | async)">
        🗑️ {{ 'projectSwitcher.delete' | translate }}
      </button>

      <button mat-stroked-button
              (click)="leaveProject()"
              [disabled]="leaving || loading || !canLeave || !(isOnline$ | async)">
        🚪 {{ 'projectSwitcher.leave' | translate }}
      </button>
    </div>

    <ng-template #noItems>
      <mat-option [disabled]="true">{{ 'projectSwitcher.noProjects' | translate }}</mat-option>
    </ng-template>
  `
})
export class ProjectSwitcher implements OnDestroy {
  projects: MyProject[] = [];
  selected: string | null = null;
  private prevSelected: string | null = null;
  loading = true;

  creating = false;
  deleting = false;
  leaving  = false;

  isOnline$!: Observable<boolean>;
  private onlineNow = true;

  private stopMembershipWatch?: () => void;
  private currentUid: string | null = null;

  constructor(
    private current: CurrentProjectService,
    private dir: ProjectDirectoryService,
    private authSvc: AuthService,
    private fs: Firestore,
    private cdr: ChangeDetectorRef,
    private network: NetworkService
  ) {}

  async ngOnInit() {
    this.isOnline$ = this.network.isOnline$;
    this.isOnline$.subscribe(v => { this.onlineNow = !!v; });

    const uid = await firstValueFrom(this.authSvc.uid$);
    this.currentUid = uid ?? null;
    if (!uid) { this.loading = false; this.cdr.markForCheck(); return; }

    await this.reload(uid);

    const curr = this.current.getSync();
    if (curr && this.projects.some(p => p.pid === curr)) {
      this.selected = curr;
      this.prevSelected = curr;
      this.startMembershipWatch(curr, uid);
    } else {
      this.selected = this.projects[0]?.pid ?? null;
      this.prevSelected = this.selected;
      this.current.set(this.selected);
      if (this.selected) this.startMembershipWatch(this.selected, uid);
    }
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void { this.stopMembershipWatch?.(); }

  private async requireOnline(): Promise<boolean> {
    const ok = await firstValueFrom(this.isOnline$);
    if (!ok) { alert('オフラインのため操作できません'); }
    return !!ok;
  }

  onChange(pid: string | null) {
    if (!this.onlineNow) {
      alert('オフラインのためプロジェクトを切り替えられません');
      this.selected = this.prevSelected;
      this.cdr.markForCheck();
      return;
    }
    this.current.set(pid);
    this.selected = pid;
    this.prevSelected = pid;
    this.stopMembershipWatch?.();
    if (pid && this.currentUid) this.startMembershipWatch(pid, this.currentUid);
    this.cdr.markForCheck();
  }

  private get selectedRole(): 'admin'|'member'|'viewer'|null {
    return this.projects.find(p => p.pid === this.selected)?.role ?? null;
  }
  get canDelete() { return this.selectedRole === 'admin'; }
  get canLeave()  { return this.selectedRole === 'member' || this.selectedRole === 'viewer'; }

  private startMembershipWatch(pid: string, uid: string) {
    const ref = doc(this.fs as any, `projects/${pid}/members/${uid}`);
    this.stopMembershipWatch = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          this.current.set(null);
          this.selected = null;
          this.prevSelected = null;
          this.cdr.markForCheck();
          this.stopMembershipWatch?.();
        }
      },
      (_err: any) => {
        this.current.set(null);
        this.selected = null;
        this.prevSelected = null;
        this.cdr.markForCheck();
        this.stopMembershipWatch?.();
      }
    );
  }

  private async reload(uid: string) {
    this.loading = true; this.cdr.markForCheck();
    try {
      try {
        this.projects = await this.dir.listMine(uid);
      } catch {
        this.projects = await this.listMineByMemberships(uid);
      }
    } catch {
      this.projects = [];
    } finally {
      if (this.selected && !this.projects.find(p => p.pid === this.selected)) {
        this.current.set(null);
        this.selected = null;
        this.prevSelected = null;
        this.stopMembershipWatch?.();
      }
      this.loading = false; this.cdr.markForCheck();
    }
  }

  async createProject() {
    if (!await this.requireOnline()) return;
    try {
      this.creating = true; this.cdr.markForCheck();
      const u = (this.authSvc as any).auth?.currentUser;
      if (!u) { await this.authSvc.signInWithGoogle(true); return; }

      const name = prompt('新規プロジェクト名を入力してください', `${u.displayName || 'My'} Project`);
      if (!name) return;

      const projRef = await addDoc(collection(this.fs as any, 'projects'), {
        meta: { name, createdBy: u.uid, createdAt: serverTimestamp() }
      });
      const pid = projRef.id;

      await setDoc(doc(this.fs as any, `projects/${pid}/members/${u.uid}`), {
        role: 'admin',
        joinedAt: serverTimestamp(),
        displayName: u.displayName ?? 'User',
        email: u.email ?? null,
      }, { merge: true });

      await setDoc(doc(this.fs as any, `users/${u.uid}/memberships/${pid}`), {
        role: 'admin',
        joinedAt: serverTimestamp(),
      }, { merge: true });

      await this.reload(u.uid);
      this.selected = pid;
      this.prevSelected = pid;
      this.current.set(pid);
      this.stopMembershipWatch?.();
      this.startMembershipWatch(pid, u.uid);
      alert('プロジェクトを作成しました');
    } finally {
      this.creating = false; this.cdr.markForCheck();
    }
  }

  private async safeDelete(path: string) {
    await deleteDoc(doc(this.fs as any, path)).catch((e) => { throw e; });
  }

  private async deleteProjectCascade(pid: string, adminUid: string): Promise<void> {
    const membersSnap = await getDocs(collection(this.fs as any, `projects/${pid}/members`));
    const allUids = membersSnap.docs.map(d => d.id);
    const otherUids = allUids.filter(u => u !== adminUid);

    const commits: Promise<void>[] = [];
    let batch = writeBatch(this.fs as any);
    let ops = 0;
    const FLUSH_AT = 450;
    const flush = () => { commits.push(batch.commit()); batch = writeBatch(this.fs as any); ops = 0; };

    for (const uid of otherUids) { batch.delete(doc(this.fs as any, `users/${uid}/memberships/${pid}`)); if (++ops >= FLUSH_AT) flush(); }
    for (const uid of otherUids) { batch.delete(doc(this.fs as any, `projects/${pid}/members/${uid}`)); if (++ops >= FLUSH_AT) flush(); }

    batch.delete(doc(this.fs as any, `projects/${pid}`)); ops++;
    batch.delete(doc(this.fs as any, `projects/${pid}/members/${adminUid}`)); ops++;
    batch.delete(doc(this.fs as any, `users/${adminUid}/memberships/${pid}`)); ops++;
    flush();

    await Promise.all(commits);
  }

  async deleteProject() {
    if (!await this.requireOnline()) return;
    try {
      this.deleting = true; this.cdr.markForCheck();
      const u = (this.authSvc as any).auth?.currentUser;
      const pid = this.selected;
      if (!u || !pid) return;

      const snap = await getDoc(doc(this.fs as any, `projects/${pid}/members/${u.uid}`));
      const myRole = snap.exists() ? (snap.data() as any).role : null;
      if (myRole !== 'admin') { alert('管理者だけが削除できます'); return; }

      if (!confirm('このプロジェクトを完全に削除します。よろしいですか？（元に戻せません）')) return;

      this.current.set(null);
      this.selected = null; this.prevSelected = null; this.stopMembershipWatch?.(); this.cdr.markForCheck();

      try {
        const invs = await getDocs(collection(this.fs as any, `projects/${pid}/invites`));
        for (const d of invs.docs) { await this.safeDelete(d.ref.path); }
      } catch {}

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
      } catch {}

      await this.deleteProjectCascade(pid, u.uid);
      await this.reload(u.uid);

      alert('プロジェクトを削除しました');
    } finally {
      this.deleting = false; this.cdr.markForCheck();
    }
  }

  private async unassignAllTasksForUser(pid: string, uid: string) {
    const probs = await getDocs(collection(this.fs as any, `projects/${pid}/problems`)).catch(() => null);
    if (!probs) return;
    for (const p of probs.docs) {
      const issues = await getDocs(collection(this.fs as any, `projects/${pid}/problems/${p.id}/issues`)).catch(() => null);
      if (!issues) continue;
      for (const i of issues.docs) {
        const tasks = await getDocs(query(
          collection(this.fs as any, `projects/${pid}/problems/${p.id}/issues/${i.id}/tasks`),
          where('assignees', 'array-contains', uid)
        )).catch(() => null);
        if (!tasks) continue;
        for (const t of tasks.docs) {
          await updateDoc(t.ref, { assignees: arrayRemove(uid), updatedAt: serverTimestamp() as any }).catch(() => {});
        }
      }
    }
  }

  async leaveProject() {
    if (!await this.requireOnline()) return;
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

      this.current.set(null);
      this.selected = null; this.prevSelected = null; this.stopMembershipWatch?.(); this.cdr.markForCheck();

      await this.unassignAllTasksForUser(pid, u.uid);
      await deleteDoc(doc(this.fs as any, `users/${u.uid}/memberships/${pid}`)).catch(() => {});
      await deleteDoc(memberRef).catch(() => {});
      await this.reload(u.uid);

      alert('退出しました');
    } finally {
      this.leaving = false; this.cdr.markForCheck();
    }
  }

  private async listMineByMemberships(uid: string): Promise<MyProject[]> {
    const ms = await getDocs(collection(this.fs as any, `users/${uid}/memberships`));
    const items = await Promise.all(ms.docs.map(async (m) => {
      const pid = m.id;
      const role = (m.data() as any)?.role ?? 'viewer';
      const pSnap = await getDoc(doc(this.fs as any, `projects/${pid}`)).catch(() => null);
      const name = pSnap?.exists() ? ((pSnap.data() as any)?.meta?.name ?? '(no name)') : '(deleted)';
      return { pid, name, role } as MyProject;
    }));
    return items.filter(p => p.name !== '(deleted)');
  }
}




