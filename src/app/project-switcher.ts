// src/app/project-switcher.ts
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Router } from '@angular/router';

import { ProjectDirectoryService, MyProject } from './services/project-directory.service';
import { CurrentProjectService } from './services/current-project.service';
import { AuthService } from './services/auth.service';
import { NetworkService } from './services/network.service';

import { Observable, Subscription, firstValueFrom } from 'rxjs';

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
  imports: [CommonModule, MatButtonModule, MatIconModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; height: 100%; }
    .switcher { display: flex; flex-direction: column; gap: var(--gap-2); height: 100%; }
    .switcher__header { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-1); }
    .switcher__header h2 { margin: 0; font-size: calc(13px * var(--m)); letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.92); }
    .status-hint { font-size: calc(11px * var(--m)); color: rgba(255, 255, 255, 0.6); }

    .offline { display: inline-flex; align-items: center; gap: var(--gap-1); font-size: calc(11px * var(--m)); color: var(--accent-red);
      background: color-mix(in srgb, var(--accent-red) 16%, transparent); border: 1px solid color-mix(in srgb, var(--accent-red) 45%, transparent);
      padding: calc(4px * var(--m)) calc(8px * var(--m)); border-radius: var(--radius); }

    .switcher__list { display: flex; flex-direction: column; gap: var(--gap-1); overflow-y: auto; padding-right: calc(2px * var(--m)); }

    .switcher__item {
      display: inline-flex; align-items: center; width: 100%;
      border-radius: 999px; padding: calc(6px * var(--m)) calc(10px * var(--m));
      background: rgba(255, 255, 255, 0.08); color: inherit; text-align: left;
      transition: background-color .15s ease, box-shadow .15s ease, border-color .15s ease;
      border: 1px solid rgba(255, 255, 255, 0.12); cursor: pointer; box-shadow: 0 10px 24px rgba(2, 6, 23, 0.35);
      /* ここ重要：中寄せ用に内部ラッパを中央配置 */
      justify-content: center;
    }
    .switcher__item:hover { background: rgba(255, 255, 255, 0.16); border-color: rgba(255, 255, 255, 0.22); }
    .switcher__item.is-active { background: color-mix(in srgb, var(--accent-blue) 30%, rgba(255, 255, 255, 0.08) 70%); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-blue) 55%, transparent); border-color: color-mix(in srgb, var(--accent-blue) 45%, transparent); }
    .switcher__item:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 2px; }
    .switcher__item[disabled] { opacity: .5; cursor: default; }

    /* 中寄せ用の内側コンテナ：横幅を少し狭めて左右に余白を持たせる */
    .switcher__inner {
      display: inline-flex; align-items: center; gap: calc(10px * var(--m));
      width: 100%; max-width: 88%; /* ← ここで両端に余白を確保（お好みで 82–92% 程度） */
      justify-content: space-between;
      margin-inline: auto;  /* ボタン内で中央寄せ */
      min-width: 0;
    }

    .label { display: inline-flex; align-items: center; gap: var(--gap-1); min-width: 0; }
    .switcher__dot { width: calc(8px * var(--m)); height: calc(8px * var(--m)); border-radius: 50%; background: color-mix(in srgb, var(--accent-blue) 60%, transparent); flex-shrink: 0; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.12); }
    .switcher__name { font-weight: 600; line-height: 1.2; min-width: 0; font-size: calc(13px * var(--m)); color: rgba(255, 255, 255, 0.95); }
    .switcher__name.no-truncate { white-space: nowrap; }
    .switcher__role { font-size: calc(11px * var(--m)); color: rgba(255, 255, 255, 0.6); flex-shrink: 0; }

    .switcher__placeholder { font-size: calc(12px * var(--m)); color: rgba(255, 255, 255, 0.64); padding: var(--pad-1); border: 1px dashed rgba(255, 255, 255, 0.18); border-radius: var(--radius); text-align: center; background: rgba(255, 255, 255, 0.04); }

    .switcher__actions { display: flex; flex-direction: column; gap: var(--gap-1); margin-top: auto; padding-top: var(--gap-2); border-top: 1px solid rgba(255, 255, 255, 0.08); }
    .switcher__actions button { justify-content: flex-start; gap: var(--gap-1); border-radius: 999px; color: rgba(255, 255, 255, 0.92); border-color: rgba(255, 255, 255, 0.2) !important; }
    .switcher__actions button:hover { border-color: color-mix(in srgb, var(--accent-blue) 48%, rgba(255, 255, 255, 0.2)); }
    .switcher__actions .mat-mdc-button { font-size: calc(12px * var(--m)); height: calc(28px * var(--m)); min-height: calc(28px * var(--m)); }

    /* モバイル対応 */
    @media (max-width: 768px) {
      .switcher__wrapper {
        height: 100%;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }

      .switcher__item {
        min-height: 44px; /* タップしやすいサイズ */
        padding: clamp(8px, 2vw, 12px) clamp(10px, 2.5vw, 14px);
      }

      .switcher__name {
        font-size: clamp(13px, 3.5vw, 15px);
      }

      .switcher__role {
        font-size: clamp(11px, 3vw, 13px);
      }
    }
  `],
  template: `
    <div class="switcher">
      <div class="switcher__header">
        <h2 class="no-truncate">{{ 'projectSwitcher.project' | translate }}</h2>
        <span class="status-hint" *ngIf="loading">{{ 'projectSwitcher.loading' | translate }}</span>
      </div>

      <div class="offline" *ngIf="!(isOnline$ | async)">
        <mat-icon>signal_wifi_off</mat-icon>
        <span>{{ 'projectSwitcher.offline' | translate }}</span>
      </div>

      <div class="switcher__list" *ngIf="projects.length; else emptyState">
        <button
          type="button"
          class="switcher__item"
          *ngFor="let p of projects"
          [class.is-active]="p.pid === selected"
          (click)="p.pid !== selected ? onChange(p.pid) : null"
          [attr.aria-pressed]="p.pid === selected"
        >
          <span class="switcher__inner">
            <span class="label">
              <span class="switcher__dot"></span>
              <span class="switcher__name" [title]="p.name">{{ p.name }}</span>
            </span>
            <span class="switcher__role">{{ ('role.' + p.role + 'Label') | translate }}</span>
          </span>
        </button>
      </div>

      <ng-template #emptyState>
        <div class="switcher__placeholder">
          {{ loading ? ('projectSwitcher.loading' | translate) : ('projectSwitcher.noProjects' | translate) }}
        </div>
      </ng-template>

      <div class="switcher__actions">
        <button mat-stroked-button type="button" (click)="createProject()" [disabled]="creating || loading || !(isOnline$ | async)">
          <mat-icon>add</mat-icon>
          <span>{{ 'projectSwitcher.new' | translate }}</span>
        </button>

        <!-- 追加：プロジェクト名変更（管理者のみ） -->
        <button mat-stroked-button type="button" (click)="renameProject()"
         [disabled]="renaming || loading || !(isOnline$ | async)">
          <mat-icon>edit</mat-icon>
          <span>{{ 'projectSwitcher.rename' | translate }}</span>
        </button>

        <button mat-stroked-button color="warn" type="button" (click)="deleteProject()"
         [disabled]="deleting || loading || !(isOnline$ | async)">
          <mat-icon>delete</mat-icon>
          <span>{{ 'projectSwitcher.delete' | translate }}</span>
        </button>
        <button mat-stroked-button type="button" (click)="leaveProject()"
         [disabled]="leaving || loading || !(isOnline$ | async)">
          <mat-icon>logout</mat-icon>
          <span>{{ 'projectSwitcher.leave' | translate }}</span>
        </button>
      </div>
    </div>
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
  renaming = false;

  // プロジェクト名の長さ制限
  private readonly MIN_PROJECT_NAME = 1;
  private readonly MAX_PROJECT_NAME = 20;

  isOnline$!: Observable<boolean>;
  private onlineNow = true;

  private stopMembershipWatch?: () => void;
  private stopMembershipsListWatch?: () => void;
  private authSub?: Subscription;
  private currentUid: string | null = null;
  private liveRole: 'admin'|'member'|'viewer'|null = null;

  constructor(
    private current: CurrentProjectService,
    private dir: ProjectDirectoryService,
    private authSvc: AuthService,
    private fs: Firestore,
    private cdr: ChangeDetectorRef,
    private network: NetworkService,
    private i18n: TranslateService,
    private router: Router,
  ) {}

  private startMembershipsListWatch(uid: string) {
    const colRef = collection(this.fs as any, `users/${uid}/memberships`);
    this.stopMembershipsListWatch = onSnapshot(
      colRef,
      async (snap) => {
        const items = await Promise.all(
          snap.docs.map(async (d) => {
            const pid  = d.id;
            const role = (d.data() as any)?.role ?? 'viewer';
            const pSnap = await getDoc(doc(this.fs as any, `projects/${pid}`)).catch(() => null);
            if (!pSnap?.exists()) return null;
            const name = (pSnap.data() as any)?.meta?.name ?? '(no name)';
            return { pid, name, role } as MyProject;
          })
        );
        const list = (items.filter(Boolean) as MyProject[]);
        const removedCurrent = this.selected && !list.some(p => p.pid === this.selected);
        this.projects = list;

        if (removedCurrent) {
          this.handleProjectLost('deleted');
        } else {
          this.cdr.markForCheck();
        }
      },
      (_err) => this.reload(uid)
    );
  }

  private handleProjectLost(_reason: 'removed'|'deleted'|'error') {
    // ▼ サインアウト中: アラート出さずに全部掃除
    if ((this.authSvc as any).isSigningOut) {
      this.current.set(null);
      this.selected = null;
      this.prevSelected = null;
      this.liveRole = null;
      this.stopAllWatchers();        // ← サインアウト時だけ全停止
      this.cdr.markForCheck();
      return;
    }
  
    // ▼ 通常の「プロジェクト喪失」（削除 / 追放 / エラー）
    //    → 選択解除＋そのプロジェクトの membership watcher だけ止める
    //    → memberships リスト監視は生かす（一覧を正しく更新させるため）
    this.current.set(null);
    this.selected = null;
    this.prevSelected = null;
    this.liveRole = null;
  
    this.stopProjectMembershipWatch();   // ★ここだけ
    // this.stopMembershipsListWatcher(); は呼ばない
  
    this.cdr.markForCheck();
    this.router.navigateByUrl('/', { replaceUrl: true });
    try {
      alert(this.i18n.instant('projectSwitcher.alert.projectLost'));
    } catch {}
  }

  ngOnInit() {
    this.isOnline$ = this.network.isOnline$;
    this.isOnline$.subscribe(v => { this.onlineNow = !!v; });

    this.authSub = this.authSvc.uid$.subscribe(async (uid) => {
      if (uid === this.currentUid) return;
      this.currentUid = uid ?? null;

      this.stopAllWatchers();

      if (!uid) {
        this.projects = [];
        this.current.set(null);
        this.selected = null;
        this.prevSelected = null;
        this.loading = false;
        this.liveRole = null;
        this.cdr.markForCheck();
        return;
      }

      this.startMembershipsListWatch(uid);
      await this.reload(uid);

      const curr = this.current.getSync();
      if (curr && this.projects.some(p => p.pid === curr)) {
        this.selected = curr;
      } else {
        this.selected = this.projects[0]?.pid ?? null;
        this.current.set(this.selected);
      }
      this.prevSelected = this.selected;

      if (this.selected) this.startMembershipWatch(this.selected, uid);
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.stopAllWatchers();
    this.authSub?.unsubscribe();
  }

  private async requireOnline(): Promise<boolean> {
    const ok = await firstValueFrom(this.isOnline$);
    if (!ok) { alert(this.i18n.instant('error.offlineActionBlocked')); }
    return !!ok;
  }

  onChange(pid: string | null) {
    if (!this.onlineNow) {
      alert(this.i18n.instant('projectSwitcher.cannotSwitchOffline'));
      this.selected = this.prevSelected;
      this.cdr.markForCheck();
      return;
    }
    this.current.set(pid);
    this.selected = pid;
    this.prevSelected = pid;
    this.liveRole = null;

    this.stopProjectMembershipWatch();

    if (pid && this.currentUid) this.startMembershipWatch(pid, this.currentUid);
    this.cdr.markForCheck();
  }

  private get selectedRole(): 'admin'|'member'|'viewer'|null {
    if (this.liveRole) return this.liveRole;
    return this.projects.find(p => p.pid === this.selected)?.role ?? null;
  }
  get canDelete()  { return this.selectedRole === 'admin'; }
  get canLeave()   { return this.selectedRole === 'member' || this.selectedRole === 'viewer'; }
  get canRename()  { return this.selectedRole === 'admin'; } // ← 追加

  private startMembershipWatch(pid: string, uid: string) {
    const ref = doc(this.fs as any, `projects/${pid}/members/${uid}`);
    this.stopMembershipWatch = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          this.handleProjectLost('removed');
          return;
        }
        const data = snap.data() as any;
        this.liveRole = (data?.role ?? null) as any;
        this.cdr.markForCheck();
      },
      (_err: any) => {
        this.handleProjectLost('error');
      }
    );
  }

  private stopProjectMembershipWatch() {
    if (this.stopMembershipWatch) {
      try { this.stopMembershipWatch(); } catch {}
      this.stopMembershipWatch = undefined;
    }
  }

  private stopMembershipsListWatcher() {
    if (this.stopMembershipsListWatch) {
      try { this.stopMembershipsListWatch(); } catch {}
      this.stopMembershipsListWatch = undefined;
    }
  }

  private stopAllWatchers() {
    this.stopProjectMembershipWatch();
    this.stopMembershipsListWatcher();
  }

  private async reload(uid: string) {
    this.loading = true; this.cdr.markForCheck();
    try {
      try {
        this.projects = await firstValueFrom(this.dir.listMine$(uid));
      } catch {
        this.projects = await this.listMineByMemberships(uid);
      }
    } catch {
      this.projects = [];
    } finally {
      if (this.selected && !this.projects.find(p => p.pid === this.selected)) {
        this.handleProjectLost('deleted');
      }
      this.loading = false; this.cdr.markForCheck();
    }
  }

  async createProject() {
    if (!await this.requireOnline()) return;
    try {
      this.creating = true; this.cdr.markForCheck();
      const u = (this.authSvc as any).auth?.currentUser;
      if (!u) {
        await this.authSvc.signInWithGoogle({ forceChoose: true });
        return;
      }

      const placeholder = `${u.displayName || 'My'} Project`;
      const input = prompt(this.i18n.instant('projectSwitcher.prompt.createName'), placeholder);
      if (input === null) return; // キャンセル

      const name = this.normalizedProjectName(input);
      if (!this.isValidProjectName(name)) {
        alert(
          this.tt(
            'projectSwitcher.validation.nameLength',
            `プロジェクト名は${this.MIN_PROJECT_NAME}〜${this.MAX_PROJECT_NAME}文字で入力してください`
          )
        );
        return;
      }

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
      this.stopProjectMembershipWatch();
      this.startMembershipWatch(pid, u.uid);
      alert(this.i18n.instant('projectSwitcher.alert.created'));
    } finally {
      this.creating = false; this.cdr.markForCheck();
    }
  }


  // === 追加：プロジェクト名変更 ===
  async renameProject() {
    if (!await this.requireOnline()) return;
    try {
      this.renaming = true; this.cdr.markForCheck();
      const u = (this.authSvc as any).auth?.currentUser;
      const pid = this.selected;
      if (!u || !pid) return;

      // 管理者チェック
      const memberSnap = await getDoc(doc(this.fs as any, `projects/${pid}/members/${u.uid}`));
      const myRole = memberSnap.exists() ? (memberSnap.data() as any).role : null;
      if (myRole !== 'admin') {
        alert(this.i18n.instant('projectSwitcher.alert.renameOnlyAdmin'));
        return;
      }

      // 現在名の取得
      const projSnap = await getDoc(doc(this.fs as any, `projects/${pid}`));
      const currentNameRaw = projSnap.exists() ? ((projSnap.data() as any)?.meta?.name ?? '') : '';
      const currentName = this.normalizedProjectName(currentNameRaw);

      const input = prompt(
        this.i18n.instant('projectSwitcher.prompt.rename'),
        currentName || 'Project'
      );
      if (input === null) return; // キャンセル

      const newName = this.normalizedProjectName(input);

      if (newName === currentName) return;

      if (!this.isValidProjectName(newName)) {
        alert(
          this.tt(
            'projectSwitcher.validation.nameLength',
            `プロジェクト名は${this.MIN_PROJECT_NAME}〜${this.MAX_PROJECT_NAME}文字で入力してください`
          )
        );
        return;
      }

      await setDoc(
        doc(this.fs as any, `projects/${pid}`),
        { meta: { name: newName, updatedAt: serverTimestamp() } },
        { merge: true }
      );

      await this.reload(u.uid);
      alert(this.i18n.instant('projectSwitcher.alert.renamed'));
    } finally {
      this.renaming = false; this.cdr.markForCheck();
    }
  }


  private async safeDelete(path: string) { await deleteDoc(doc(this.fs as any, path)).catch((e) => { throw e; }); }

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
      if (myRole !== 'admin') { alert(this.i18n.instant('projectSwitcher.alert.deleteOnlyAdmin')); return; }

      if (!confirm(this.i18n.instant('projectSwitcher.confirm.delete'))) return;

      this.current.set(null);
      this.selected = null;
      this.prevSelected = null;
      this.stopProjectMembershipWatch();
      this.cdr.markForCheck();

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

      alert(this.i18n.instant('projectSwitcher.alert.deleted'));
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
      if (role === 'admin') { alert(this.i18n.instant('projectSwitcher.alert.adminCannotLeave')); return; }

      if (!confirm(this.i18n.instant('projectSwitcher.confirm.leave'))) return;

      this.current.set(null);
      this.selected = null;
      this.prevSelected = null;
      this.stopProjectMembershipWatch();
      this.cdr.markForCheck();

      await this.unassignAllTasksForUser(pid, u.uid);
      await deleteDoc(doc(this.fs as any, `users/${u.uid}/memberships/${pid}`)).catch(() => {});
      await deleteDoc(memberRef).catch(() => {});
      await this.reload(u.uid);

      alert(this.i18n.instant('projectSwitcher.alert.left'));
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

    // 入力をトリムして正規化
    private normalizedProjectName(input: string | null | undefined): string {
      return (input ?? '').trim();
    }
  
    // 1〜30文字チェック
    private isValidProjectName(name: string): boolean {
      const len = name.length;
      return len >= this.MIN_PROJECT_NAME && len <= this.MAX_PROJECT_NAME;
    }
  
    // i18n → なければフォールバック文言
    private tt(key: string, fallback: string): string {
      const v = this.i18n.instant(key);
      return v && v !== key ? v : fallback;
    }
  
}







