import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { CurrentProjectService } from '../services/current-project.service';
import { AuthService } from '../services/auth.service';
import { ProjectDirectoryService } from '../services/project-directory.service';
import { combineLatest, of } from 'rxjs';
import { switchMap, map, take } from 'rxjs/operators';

/**
 * プロジェクト選択が必須のページを保護するガード。
 * - authGuard でログイン済み前提
 * - 現在プロジェクトが「自分の membership に存在」するときのみ通す
 */
export const projectGuard: CanActivateFn = () => {
  const router = inject(Router);
  const current = inject(CurrentProjectService);
  const auth = inject(AuthService);
  const dir = inject(ProjectDirectoryService);

  return combineLatest([
    current.projectId$.pipe(take(1)),
    auth.uid$.pipe(take(1)),
  ]).pipe(
    switchMap(([pid, uid]) => {
      if (!pid || !uid) {
        return of(router.createUrlTree(['/']));
      }
      // 所属ドキュメントを 1 回だけ確認
      return dir.roleDoc$(pid, uid).pipe(
        take(1),
        map(roleDoc => {
          if (roleDoc && roleDoc.role) return true;
          // ステールな projectId を握っていた場合の掃除
          current.set(null);
          return router.createUrlTree(['/']);
        })
      );
    })
  );
};

