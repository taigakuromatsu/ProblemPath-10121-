import { Observable, of } from 'rxjs';
import { catchError, distinctUntilChanged, filter, switchMap } from 'rxjs/operators';

/** projectId$ が null なら即座に fallback、取得中/permission-denied でも fallback を返す共通ヘルパ */
export function safeFromProject$<T>(
  projectId$: Observable<string | null>,
  mk$: (pid: string) => Observable<T>,
  fallback: T
): Observable<T> {
  return projectId$.pipe(
    distinctUntilChanged(),
    switchMap(pid => pid ? mk$(pid).pipe(
      catchError(() => of(fallback))
    ) : of(fallback))
  );
}

/** null を弾いて pid を流すユーティリティ（必要なら） */
export function pidOnly$(projectId$: Observable<string | null>): Observable<string> {
  return projectId$.pipe(filter((v): v is string => !!v));
}
