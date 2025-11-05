// src/app/guards/project.guard.ts
import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { Auth } from '@angular/fire/auth';
import { CurrentProjectService } from '../services/current-project.service';
import { TranslateService } from '@ngx-translate/core';

/**
 * プロジェクト選択が必須のページを保護するガード。
 * - 未ログイン or 現在プロジェクトなし → Home へ退避
 */
export const projectGuard: CanActivateFn = (): boolean | UrlTree => {
  const router = inject(Router);
  const auth = inject(Auth);
  const current = inject(CurrentProjectService);
  const i18n = inject(TranslateService);

  // 念のため：未ログインは Home へ（authGuard が先に弾く想定だが保険）
  if (!auth.currentUser) {
    return router.createUrlTree(['/']);
  }

  // プロジェクト未選択なら退避
  const pid = current.getSync();
  if (!pid) {
    // 軽い通知（必要なら MatSnackBar に差し替え可）
    try { alert(i18n.instant('guard.projectRequired')); } catch {}
    return router.createUrlTree(['/']);
  }

  return true;
};
