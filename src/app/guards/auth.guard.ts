import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { map, take } from 'rxjs/operators';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.loggedIn$.pipe(
    take(1),
    map(isIn => {
      if (!isIn) {
        router.navigateByUrl('/'); // 未ログインはホームへ誘導
        return false;
      }
      return true;
    })
  );
};
