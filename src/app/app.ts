import { Component, ViewChild } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';

import { MatSidenavModule, MatSidenav } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

import { ProjectSwitcher } from './project-switcher';
import { ThemeService } from './services/theme.service';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from './services/auth.service';
import { MessagingService } from './services/messaging.service';
// 追加：DevTools から `await window.ppGetToken()` で常に最新IDトークンを取得
import { getAuth } from '@angular/fire/auth';
(globalThis as any).ppGetToken = async () => {
  const auth = getAuth();
  const u = auth.currentUser || await new Promise<any>(r => {
    const off = auth.onAuthStateChanged(x => { off(); r(x); });
  });
  const t = await u.getIdToken(true); // ← 強制リフレッシュ
  console.log('ID_TOKEN=', t);
  return t;
};


@Component({
  standalone: true,
  selector: 'app-root',
  imports: [
    AsyncPipe, NgFor, NgIf,
    RouterOutlet, RouterLink, RouterLinkActive,
    MatSidenavModule, MatToolbarModule, MatIconModule, MatButtonModule,
    ProjectSwitcher, TranslateModule
  ],
  template: `
    <mat-sidenav-container class="shell">
      <!-- 左サイド（幅は styles.scss の --sidebar で調整） -->
      <mat-sidenav
        #drawer
        class="shell__sidenav sidenav--dark"
        [mode]="(isHandset$ | async) ? 'over' : 'side'"
        [opened]="!(isHandset$ | async)"
        [autoFocus]="false"
      >
        <div class="sidenav__wrapper">
          <pp-project-switcher></pp-project-switcher>
        </div>
      </mat-sidenav>

      <!-- 右側コンテンツ -->
      <mat-sidenav-content class="shell__content">
        <mat-toolbar color="primary" class="topbar">
          <!-- モバイル用メニュー -->
          <button
            mat-icon-button
            class="menu-button"
            (click)="drawer.toggle()"
            *ngIf="isHandset$ | async"
            aria-label="Toggle navigation"
          >
            <mat-icon>menu</mat-icon>
          </button>

          <!-- ブランド -->
          <div class="brand" aria-label="ProblemPath">
            <span class="brand__title">ProblemPath</span>
          </div>

          <!-- タブ（押しやすい“ボタン”表示） -->
          <nav class="topnav minw-0" aria-label="Primary navigation">
            <a
              mat-stroked-button
              class="tab-btn"
              *ngFor="let link of navLinks"
              [routerLink]="link.path"
              routerLinkActive="active"
              [routerLinkActiveOptions]="{ exact: link.exact }"
            >
              {{ link.label | translate }}
            </a>
          </nav>

          <span class="spacer"></span>

          <!-- 右側：サインイン/アウト＆ユーザー名（40%縮小） -->
          <div class="topbar-actions topbar-right minw-0" role="group" aria-label="Toolbar actions">
            <ng-container *ngIf="auth.loggedIn$ | async; else signIn">
              <button mat-stroked-button type="button" class="auth-button auth--compact" (click)="auth.signOut()">
                {{ 'auth.signOut' | translate }}
              </button>
              <span class="user-chip user-chip--compact">
                {{ (auth.displayName$ | async) || ('auth.signedIn' | translate) }}
              </span>
            </ng-container>

            <ng-template #signIn>
              <button
                mat-flat-button
                color="accent"
                type="button"
                class="auth-button auth--compact"
                (click)="auth.signInWithGoogle({ forceChoose: true })">
                {{ 'auth.signIn' | translate }}
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
    private _msg: MessagingService
  ) {
    this.isHandset$ = this.breakpoint.observe(Breakpoints.Handset).pipe(map(result => result.matches));
  }

  ngOnInit() {
    this.theme.init();
  }

}
