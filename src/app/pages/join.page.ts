// src/app/pages/join.page.ts
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../services/auth.service';
import { InvitesService } from '../services/invites.service';
import { CurrentProjectService } from '../services/current-project.service';
import { Firestore } from '@angular/fire/firestore';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

@Component({
  standalone: true,
  selector: 'pp-join',
  imports: [CommonModule, RouterLink, MatButtonModule],
  template: `
    <h2>Join Project</h2>

    <div *ngIf="error" style="padding:12px; border:1px solid #fca5a5; background:#fef2f2; border-radius:8px;">
      {{ error }}
    </div>

    <ng-container *ngIf="!error">
      <p *ngIf="!invite">招待を確認中...</p>

      <div *ngIf="invite">
        <p>このプロジェクトに <strong>{{ invite.role }}</strong> 権限で参加します。</p>

        <ng-container *ngIf="authUser; else needLogin">
          <button mat-raised-button color="primary" (click)="accept()">参加する</button>
          <a mat-stroked-button routerLink="/tree" style="margin-left:8px;">キャンセル</a>
        </ng-container>

        <ng-template #needLogin>
          <button mat-raised-button color="primary" (click)="login()">ログインして続行</button>
        </ng-template>
      </div>
    </ng-container>
  `
})
export class JoinPage {
  pid = '';
  token = '';
  invite: { role: 'admin'|'member'|'viewer', email?: string } | null = null;
  error: string | null = null;

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
      this.error = '無効な招待URLです。';
      return;
    }
    const inv = await this.invites.get(this.pid, this.token);
    if (!inv) { this.error = '招待が見つかりません（使用済み/期限切れの可能性）。'; return; }
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
  
      // もし招待に email 指定があるなら照合（任意）
      if (this.invite?.email && u.email && this.invite.email !== u.email) {
        this.error = 'この招待は別のメールアドレス用です。正しいアカウントでログインしてください。';
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
          invitedBy: (u.email ?? 'unknown') // 文字列ならOK（ルールは値内容を強制していない）
        },
        { merge: true } // 既に doc が存在しても update 許可により通る
      );
  
      await this.invites.markRedeemed(this.pid, this.token, uid);
  
      this.current.set(this.pid);
      this.router.navigateByUrl('/tree');
    } catch (e: any) {
      this.error = e?.message ?? '参加に失敗しました。';
    }
  }
  
}
