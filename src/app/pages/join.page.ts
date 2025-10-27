import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../services/auth.service';
import { InvitesService } from '../services/invites.service';
import { CurrentProjectService } from '../services/current-project.service';
import { Firestore } from '@angular/fire/firestore';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  standalone: true,
  selector: 'pp-join',
  imports: [CommonModule, RouterLink, MatButtonModule, TranslateModule],
  template: `
    <h2>{{ 'join.title' | translate }}</h2>

    <div *ngIf="errorKey" style="padding:12px; border:1px solid #fca5a5; background:#fef2f2; border-radius:8px;">
      {{ errorKey | translate }}
    </div>

    <ng-container *ngIf="!errorKey">
      <p *ngIf="!invite">{{ 'join.loading' | translate }}</p>

      <div *ngIf="invite">
        <p>
          {{ 'join.willJoinAs' | translate:{ role: (('role.' + invite.role + 'Label') | translate) } }}
        </p>

        <ng-container *ngIf="authUser; else needLogin">
          <button mat-raised-button color="primary" (click)="accept()">
            {{ 'join.accept' | translate }}
          </button>
          <a mat-stroked-button routerLink="/tree" style="margin-left:8px;">
            {{ 'common.cancel' | translate }}
          </a>
        </ng-container>

        <ng-template #needLogin>
          <button mat-raised-button color="primary" (click)="login()">
            {{ 'join.loginToContinue' | translate }}
          </button>
        </ng-template>
      </div>
    </ng-container>
  `
})
export class JoinPage {
  pid = '';
  token = '';
  invite: { role: 'admin'|'member'|'viewer', email?: string } | null = null;

  /** エラーは翻訳キーで保持 */
  errorKey: string | null = null;

  get authUser() { return (this.auth as any).auth?.currentUser ?? null; }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private invites: InvitesService,
    private current: CurrentProjectService,
    private auth: AuthService,
    private fs: Firestore
  ) {}

  async ngOnInit() {
    this.pid = this.route.snapshot.queryParamMap.get('pid') || '';
    this.token = this.route.snapshot.queryParamMap.get('token') || '';
    
    if (!this.pid || !this.token) {
      this.errorKey = 'join.invalidUrl';
      return;
    }
    const inv = await this.invites.get(this.pid, this.token);
    if (!inv) {
      this.errorKey = 'join.notFound';
      return;
    }
    this.invite = { role: inv.role, email: inv.email };
  }

  async login() {
    await this.auth.signInWithGoogle(true);
    await this.ngOnInit(); // 再チェック
  }

  async accept() {
    try {
      const u = (this.auth as any).auth.currentUser;
      if (!u) { await this.login(); return; }
      const uid = u.uid;

      // 招待に email 指定がある場合は照合
      if (this.invite?.email && u.email && this.invite.email !== u.email) {
        this.errorKey = 'join.emailMismatch';
        return;
      }

      const mRef = doc(this.fs as any, `users/${uid}/memberships/${this.pid}`);
      await setDoc(mRef, { role: this.invite!.role, joinedAt: serverTimestamp() }, { merge: true });

      const pRef = doc(this.fs as any, `projects/${this.pid}/members/${uid}`);
      await setDoc(
        pRef,
        {
          role: this.invite!.role,
          joinedAt: serverTimestamp(),
          inviteId: this.token,
          invitedBy: (u.email ?? 'unknown'),
          displayName: u.displayName ?? 'User',
          email: u.email ?? null,
        },
        { merge: true }
      );

      await this.invites.markRedeemed(this.pid, this.token, uid);

      this.current.set(this.pid);
      this.router.navigateByUrl('/tree');
    } catch (_e: any) {
      this.errorKey = 'join.acceptFailed';
    }
  }
}

