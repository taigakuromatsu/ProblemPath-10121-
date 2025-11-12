import { Component, ViewChild, inject } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { map } from 'rxjs/operators';
import { Observable, firstValueFrom } from 'rxjs';

import { MatSidenavModule, MatSidenav } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';

import { ProjectSwitcher } from './project-switcher';
import { ThemeService } from './services/theme.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from './services/auth.service';
import { MessagingService } from './services/messaging.service';
import { CurrentProjectService } from './services/current-project.service';

import { Firestore, doc, setDoc, serverTimestamp } from '@angular/fire/firestore';

// DevTools: await window.ppGetToken()
import { getAuth } from '@angular/fire/auth';
(globalThis as any).ppGetToken = async () => {
  const auth = getAuth();
  const u = auth.currentUser || await new Promise<any>(r => {
    const off = auth.onAuthStateChanged(x => { off(); r(x); });
  });
  const t = await u.getIdToken(true);
  console.log('ID_TOKEN=', t);
  return t;
};

/* ───────── メール/パスワード ダイアログ ───────── */
@Component({
  standalone: true,
  selector: 'pp-email-login-dialog',
  imports: [MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, FormsModule, NgIf, MatSnackBarModule],
  template: `
    <h2 mat-dialog-title>メールでログイン</h2>
    <div mat-dialog-content style="display:grid; gap:12px; width:min(420px,90vw);">
      <mat-form-field appearance="outline">
        <mat-label>メールアドレス</mat-label>
        <input matInput [(ngModel)]="email" type="email" autocomplete="email" />
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>パスワード</mat-label>
        <input matInput [(ngModel)]="password" type="password" autocomplete="current-password" />
      </mat-form-field>
      <small class="hint" style="opacity:.7">※ アカウントが無い場合は「新規登録」で作成できます。</small>
      <div *ngIf="error" style="color:#d32f2f; font-size:12px;">{{ error }}</div>
    </div>
    <div mat-dialog-actions style="justify-content:space-between; gap:8px;">
      <button mat-button (click)="reset()" [disabled]="busy || !email">パスワードをリセット</button>
      <span style="flex:1"></span>
      <button mat-button (click)="close()" [disabled]="busy">キャンセル</button>
      <button mat-stroked-button color="primary" (click)="signin()" [disabled]="busy || !email || !password">サインイン</button>
      <button mat-flat-button color="primary" (click)="signup()" [disabled]="busy || !email || !password">新規登録</button>
    </div>
  `
})
export class EmailLoginDialog {
  private authSvc = inject(AuthService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);

  email = ''; password = ''; busy = false; error: string | null = null;

  close(){ this.dialog.closeAll(); }
  async signin(){
    this.error=null; this.busy=true;
    try{
      await this.authSvc.signInWithEmail(this.email.trim(), this.password);
      this.snack.open('サインインしました','OK',{duration:2500});
      this.close();
    } catch(e:any){
      this.error=this.err(e?.code);
    } finally{ this.busy=false; }
  }
  async signup(){
    this.error=null; this.busy=true;
    try{
      await this.authSvc.signUpWithEmail(this.email.trim(), this.password);
      this.snack.open('登録完了。確認メールを送信しました。','OK',{duration:3000});
      this.close();
    } catch(e:any){
      this.error=this.err(e?.code);
    } finally{ this.busy=false; }
  }
  async reset(){
    this.error=null; this.busy=true;
    try{
      await this.authSvc.resetPassword(this.email.trim());
      this.snack.open('パスワード再設定メールを送信しました','OK',{duration:3000});
    } catch(e:any){
      this.error=this.err(e?.code);
    } finally{ this.busy=false; }
  }
  private err(code?:string){
    switch(code){
      case 'auth/user-not-found': return 'ユーザーが見つかりません。';
      case 'auth/wrong-password': return 'パスワードが違います。';
      case 'auth/invalid-email': return 'メールアドレスが不正です。';
      case 'auth/email-already-in-use': return 'このメールは既に使用されています。';
      case 'auth/too-many-requests': return 'しばらくしてから再試行してください。';
      default: return `エラー: ${code ?? '不明なエラー'}`;
    }
  }
}

/* ───────── 表示名変更ダイアログ ───────── */
@Component({
  standalone: true,
  selector: 'pp-edit-name-dialog',
  imports: [
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatCheckboxModule,
    FormsModule,
    NgIf,
    TranslateModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'editName.title' | translate }}</h2>

    <div mat-dialog-content style="display:grid; gap:12px; width:min(420px,90vw);">
      <mat-form-field appearance="outline">
        <mat-label>{{ 'editName.label' | translate }}</mat-label>
        <input
          matInput
          [(ngModel)]="name"
          [attr.maxlength]="MAX_NAME"
        />
        <mat-hint align="start">
          {{ 'editName.hint' | translate:{ min: MIN_NAME, max: MAX_NAME } }}
        </mat-hint>
        <mat-hint align="end">
          {{ (name || '').length }} / {{ MAX_NAME }}
        </mat-hint>
      </mat-form-field>

      <mat-checkbox [(ngModel)]="syncMember">
        {{ 'editName.syncMember' | translate }}
      </mat-checkbox>

      <div *ngIf="error" style="color:#d32f2f; font-size:12px;">
        {{ error }}
      </div>
    </div>

    <div mat-dialog-actions style="justify-content:flex-end; gap:8px;">
      <button
        mat-button
        (click)="close()"
        [disabled]="busy"
      >
        {{ 'common.cancel' | translate }}
      </button>

      <button
        mat-flat-button
        color="primary"
        (click)="save()"
        [disabled]="busy || !isValidName()"
      >
        {{ 'common.save' | translate }}
      </button>
    </div>
  `
})
export class EditNameDialog {
  private auth = inject(AuthService);
  private fs = inject(Firestore);
  private current = inject(CurrentProjectService);
  private dialog = inject(MatDialog);
  private snack = inject(MatSnackBar);
  private tr = inject(TranslateService);

  readonly MIN_NAME = 1;
  readonly MAX_NAME = 15;

  name = '';
  syncMember = true;
  busy = false;
  error: string | null = null;

  constructor() {
    this.auth.displayName$.subscribe(n => {
      if (n != null && !this.name) this.name = n;
    });
  }

  private tt(key: string, fallback: string): string {
    const v = this.tr.instant(key);
    return v && v !== key ? v : fallback;
  }

  close() {
    this.dialog.closeAll();
  }

  isValidName(): boolean {
    const trimmed = (this.name || '').trim();
    const len = trimmed.length;
    return len >= this.MIN_NAME && len <= this.MAX_NAME;
  }

  async save() {
    this.error = null;

    const newName = (this.name || '').trim();
    const len = newName.length;

    if (len < this.MIN_NAME || len > this.MAX_NAME) {
      this.error = this.tt(
        'editName.error.length',
        `表示名は${this.MIN_NAME}〜${this.MAX_NAME}文字で入力してください`
      );
      return;
    }

    this.busy = true;
    try {
      await this.auth.updateMyDisplayName(newName);

      if (this.syncMember) {
        const uid = await firstValueFrom(this.auth.uid$);
        const pid = this.current.getSync();
        if (uid && pid) {
          const ref = doc(this.fs as any, `projects/${pid}/members/${uid}`);
          await setDoc(ref, {
            displayName: newName,
            updatedAt: serverTimestamp()
          }, { merge: true });
        }
      }

      this.snack.open(
        this.tt('editName.toast.success', '表示名を更新しました'),
        this.tt('common.ok', 'OK'),
        { duration: 2500 }
      );
      this.close();
    } catch (e: any) {
      this.error =
        e?.message ??
        this.tt('editName.error.generic', '更新に失敗しました');
    } finally {
      this.busy = false;
    }
  }
}


/* ───────── ルート App ───────── */
@Component({
  standalone: true,
  selector: 'app-root',
  imports: [
    AsyncPipe, NgFor, NgIf,
    RouterOutlet, RouterLink, RouterLinkActive,
    MatSidenavModule, MatToolbarModule, MatIconModule, MatButtonModule,
    MatDialogModule, MatSnackBarModule,
    ProjectSwitcher, TranslateModule,
  ],
  styles: [`
    /* ====== 共通（PCレイアウトは従来どおり） ====== */
    .topbar {
      display: grid;
      grid-template-columns: auto 1fr auto;
      grid-template-areas: "brand nav actions";
      align-items: center;
      column-gap: 8px;
      min-height: 48px;
    }

    .brand {
      grid-area: brand;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }

    .brand__title {
      font-size: 16px;
      white-space: nowrap;
    }

    .topnav-viewport {
      grid-area: nav;
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .topnav-viewport::-webkit-scrollbar { display: none; }

    .topnav-track {
      display: flex;
      flex-wrap: nowrap;
      gap: 6px;
      width: max-content;
      align-items: center;
    }

    .topnav-track .mdc-button {
      min-width: auto;
    }

    .tab-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: clamp(26px, 3vw, 32px);
      padding: 0 clamp(6px, 1.2vw, 10px);
      font-size: clamp(11px, 1.1vw, 13px);
      white-space: nowrap;
      flex: 0 0 auto;
    }

    .topbar-actions {
      grid-area: actions;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      flex: 0 0 auto;
      justify-self: flex-end;
    }

    .auth-button.auth--compact {
      --pp-btn-h: 26px;
      --pp-btn-px: 8px;
      min-height: var(--pp-btn-h);
      height: var(--pp-btn-h);
      padding: 0 var(--pp-btn-px);
      line-height: 1;
      font-size: 12px;
      letter-spacing: .2px;
    }
    .auth-button.auth--compact .mdc-button__label {
      transform: translateY(-.5px);
    }

    .user-chip.user-chip--compact {
      display: inline-block;                /* ellipsis/幅制御の前提 */
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 9999px;
      background: rgba(255,255,255,.25);
      white-space: nowrap;
      overflow: hidden;

      /* 15 文字 + 左右パディング 6px×2 分の幅を許容 */
      inline-size: fit-content;
      max-inline-size: calc(15em + 12px);
      text-overflow: clip;                  /* 15 文字は切らない（MAX_NAME=15なので省略記号不要） */
    }

    .menu-button { margin-right: 4px; }

    /* 対応ブラウザでは CJK 幅に最適化（ic = ideographic character） */
      @supports (max-inline-size: 1ic) {
        .user-chip.user-chip--compact {
          max-inline-size: calc(15ic + 12px);
        }
      }

    /* ====== モバイル向け調整（崩れ防止） ====== */
    @media (max-width: 768px) {
      .topbar {
        grid-template-columns: auto 1fr;
        grid-template-rows: auto auto;
        grid-template-areas:
          "brand actions"
          "nav nav";
        column-gap: 6px;
        row-gap: 4px;
        padding-inline: 4px;
      }

      .brand__title {
        font-size: 14px;
      }

      /* メニューアイコン分だけ少し右にずらして、1行目と揃えて見せる */
      .topnav-viewport {
        margin-left: 36px;
      }

      .topnav-track {
        gap: 4px;
      }

      .tab-btn {
        height: 26px;
        padding: 0 6px;
        font-size: 10px;
      }

      .topbar-actions {
        gap: 4px;
      }

      .user-chip.user-chip--compact {
        max-inline-size: calc(15em + 12px);
      }
    }
  `],
  template: `
    <mat-sidenav-container class="shell">
      <mat-sidenav
        #drawer
        class="shell__sidenav sidenav--dark"
        [mode]="(isHandset$ | async) ? 'over' : 'side'"
        [opened]="!(isHandset$ | async)"
        [autoFocus]="false">
        <div class="sidenav__wrapper">
          <pp-project-switcher></pp-project-switcher>
        </div>
      </mat-sidenav>

      <mat-sidenav-content class="shell__content">
        <mat-toolbar color="primary" class="topbar">
          <!-- 左：メニュー + ブランド -->
          <div class="brand" aria-label="ProblemPath">
            <button
              mat-icon-button
              class="menu-button"
              (click)="drawer.toggle()"
              *ngIf="isHandset$ | async"
              aria-label="Toggle navigation">
              <mat-icon>menu</mat-icon>
            </button>
            <span class="brand__title">ProblemPath</span>
          </div>

          <!-- 中央：タブ（モバイル時は2段目に回る） -->
          <div class="topnav-viewport" aria-label="Primary navigation">
            <div class="topnav-track">
              <a
                mat-stroked-button
                class="tab-btn"
                *ngFor="let link of navLinks"
                [routerLink]="link.path"
                routerLinkActive="active"
                [routerLinkActiveOptions]="{ exact: link.exact }">
                {{ link.label | translate }}
              </a>
            </div>
          </div>

          <!-- 右：アクション -->
          <div class="topbar-actions" role="group" aria-label="Toolbar actions">
            <ng-container *ngIf="auth.loggedIn$ | async; else signIn">
              <button
                mat-stroked-button
                type="button"
                class="tab-btn"
                (click)="openEditName()">
                名前変更
              </button>
              <span class="user-chip user-chip--compact">
                {{ (auth.displayName$ | async) || ('auth.signedIn' | translate) }}
              </span>
              <button
                mat-stroked-button
                type="button"
                class="tab-btn"
                (click)="auth.signOut()">
                {{ 'auth.signOut' | translate }}
              </button>
            </ng-container>

            <ng-template #signIn>
              <button
                mat-flat-button
                color="accent"
                type="button"
                class="tab-btn"
                (click)="auth.signInWithGoogle({ forceChoose: true })">
                Googleでログイン
              </button>
              <button
                mat-stroked-button
                type="button"
                class="tab-btn"
                (click)="openEmailLogin()">
                メールでログイン
              </button>
            </ng-template>
          </div>
        </mat-toolbar>

        <div class="content-area">
          <router-outlet></router-outlet>
        </div>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `
})
export class App {
  readonly navLinks = [
    { label: 'nav.home', path: '/', exact: true },
    { label: 'nav.tree', path: '/tree', exact: false },
    { label: 'nav.board', path: '/board', exact: false },
    { label: 'nav.schedule', path: '/schedule', exact: false },
    { label: 'nav.my', path: '/my', exact: false },
    { label: 'nav.analytics', path: '/analytics', exact: false },
    { label: 'nav.reports', path: '/reports', exact: false }
  ];

  readonly isHandset$: Observable<boolean>;
  @ViewChild('drawer') drawer!: MatSidenav;

  constructor(
    private theme: ThemeService,
    private breakpoint: BreakpointObserver,
    public auth: AuthService,
    private _msg: MessagingService,
    private dialog: MatDialog
  ){
    this.isHandset$ = this.breakpoint
      .observe(Breakpoints.Handset)
      .pipe(map(r => r.matches));
  }

  ngOnInit(){
    this.theme.init();
  }

  openEmailLogin(){
    this.dialog.open(EmailLoginDialog, { disableClose: true });
  }

  openEditName(){
    this.dialog.open(EditNameDialog, { disableClose: true });
  }
}



