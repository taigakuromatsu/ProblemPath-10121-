// src/app/app.component.ts
import { Component, OnInit, DestroyRef } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { NgIf, AsyncPipe } from '@angular/common';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NetworkService } from './services/network.service';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, NgIf, AsyncPipe, MatSnackBarModule],
  template: `
    <!-- オフライン警告バナー（全ページ共通・最上部固定） -->
    <div *ngIf="!(net.isOnline$ | async)"
         style="position:sticky; top:0; z-index:2000;
                background:#fee2e2; color:#7f1d1d;
                border-bottom:1px solid #fecaca;
                padding:6px 10px; display:flex; gap:8px; align-items:center;">
      <span style="font-weight:700;">オフラインです。</span>
      <span style="opacity:.9;">変更は保存されず、一部操作は無効化されます。接続が回復すると自動で再開します。</span>
    </div>

    <header style="display:flex;gap:12px;align-items:center;padding:8px 12px;border-bottom:1px solid #333;">
      <strong>ProblemPath</strong>
      <a routerLink="/">Home</a>
      <a routerLink="/tree">Tree</a>
      <a routerLink="/board">Board</a>
      <a routerLink="/schedule">Schedule</a>
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
    private destroyRef: DestroyRef
  ) {}

  ngOnInit(): void {
    this.net.isOnline$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(online => {
        this.snack.open(
          online ? 'オンラインに復帰しました（操作を再開できます）'
                 : 'オフラインです（保存や更新は停止します）',
          undefined,
          { duration: 3000 }
        );
      });
  }
}

