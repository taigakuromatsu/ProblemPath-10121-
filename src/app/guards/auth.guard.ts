// src/app/guards/auth.guard.ts
import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { map, take } from 'rxjs/operators';

export const authGuard: CanActivateFn = (): any => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.user$.pipe(              // user$ を直接見る方が安全
    take(1),                           // 初回の確定状態だけ使う
    map(user => {
      if (!user) {
        // 未ログイン → ホーム（またはログインページ）へ
        const tree: UrlTree = router.createUrlTree(['/']);
        return tree;
      }
      // ログイン済み → 通過
      return true;
    })
  );
};
