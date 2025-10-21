import { Injectable, inject } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { OverlayContainer } from '@angular/cdk/overlay';

export type ThemeMode = 'light' | 'dark' | 'system';

const LS_KEY = 'pp.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private overlay = inject(OverlayContainer);

  private _mode$ = new BehaviorSubject<ThemeMode>('system');
  readonly theme$ = this._mode$.asObservable();

  private media: MediaQueryList | null = null;
  private mediaHandler = () => {
    if (this._mode$.value === 'system') this.apply('system'); // システム追従
  };

  /** アプリ起動時に一度呼ぶ */
  init() {
    const saved = (localStorage.getItem(LS_KEY) as ThemeMode | null);
    const mode: ThemeMode = saved ?? 'system';
    this._mode$.next(mode);
    this.apply(mode);

    // system モード用の OS テーマ監視
    this.media = window.matchMedia('(prefers-color-scheme: dark)');
    this.media.addEventListener?.('change', this.mediaHandler);
  }

  /** 明示的にテーマを設定（Home から呼ぶ） */
  setTheme(mode: ThemeMode) {
    this._mode$.next(mode);
    if (mode === 'system') localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, mode);
    this.apply(mode);
  }
  
  getCurrent(): 'light'|'dark'|'system' {
    const saved = (localStorage.getItem('pp.theme') as any) || 'system';
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  }

  /** 実際の DOM に適用 */
  private apply(mode: ThemeMode) {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const useDark = mode === 'dark' || (mode === 'system' && prefersDark);

    // html.dark トグル
    document.documentElement.classList.toggle('dark', useDark);

    // Material のオーバーレイにも反映（select/menus/dialog 等）
    const oc = this.overlay.getContainerElement();
    oc.classList.toggle('dark', useDark);

    // モバイルのアドレスバー色（任意だがあると嬉しい）
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (meta) meta.content = useDark ? '#111111' : '#ffffff';
  }
}

