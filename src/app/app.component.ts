import { Component, OnInit, DestroyRef } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { NgIf, AsyncPipe } from '@angular/common';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NetworkService } from './services/network.service';
import { PrefsService } from './services/prefs.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, NgIf, AsyncPipe, MatSnackBarModule, TranslateModule],
  template: `
    <!-- オフライン警告バナー（全ページ共通・最上部固定） -->
    <div *ngIf="!(net.isOnline$ | async)"
         style="position:sticky; top:0; z-index:2000;
                background:#fee2e2; color:#7f1d1d;
                border-bottom:1px solid #fecaca;
                padding:6px 10px; display:flex; gap:8px; align-items:center;">
      <span style="font-weight:700;">{{ 'app.offline.title' | translate }}</span>
      <span style="opacity:.9;">{{ 'app.offline.desc' | translate }}</span>
    </div>

    <header style="display:flex;gap:12px;align-items:center;padding:8px 12px;border-bottom:1px solid #333;">
      <strong>ProblemPath</strong>
      <a routerLink="/">{{ 'nav.home' | translate }}</a>
      <a routerLink="/tree">{{ 'nav.tree' | translate }}</a>
      <a routerLink="/board">{{ 'nav.board' | translate }}</a>
      <a routerLink="/schedule">{{ 'nav.schedule' | translate }}</a>
    </header>

    <main style="padding:16px;">
      <router-outlet></router-outlet>
    </main>
  `
})
export class AppComponent implements OnInit {
  constructor(
    public net: NetworkService,
    private snack: MatSnackBar,
    private destroyRef: DestroyRef,
    private prefs: PrefsService,
    private i18n: TranslateService,
  ) {}

  ngOnInit(): void {
    // 言語プリファレンスに追従（他ページの切替とも同期）
    this.prefs.prefs$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(p => {
        const lang = (p?.lang === 'en' ? 'en' : 'ja') as 'en' | 'ja';
        this.i18n.use(lang);
      });

    // オン/オフラインのトーストも i18n
    this.net.isOnline$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(online => {
        this.snack.open(
          online ? this.i18n.instant('toast.onlineResume')
                 : this.i18n.instant('toast.offlineStop'),
          undefined,
          { duration: 3000 }
        );
      });
  }
}


