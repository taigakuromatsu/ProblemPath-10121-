// src/app/guards/project.guard.ts
import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { CurrentProjectService } from '../services/current-project.service';
import { map, take } from 'rxjs/operators';

/**
 * プロジェクト選択が必須のページを保護するガード。
 * - authGuard でログイン済み前提
 * - 現在プロジェクトなし → Home へ退避
 */
export const projectGuard: CanActivateFn = () => {
  const router = inject(Router);
  const current = inject(CurrentProjectService);

  return current.projectId$.pipe(
    take(1),
    map(pid => {
      if (!pid) {
        // プロジェクト未選択 → Home (またはプロジェクト選択ページ) に誘導
        const tree: UrlTree = router.createUrlTree(['/']);
        return tree;
      }
      return true;
    })
  );
};
