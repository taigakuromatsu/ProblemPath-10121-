import { Injectable } from '@angular/core';
import { UserPrefs } from '../models/types';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** 将来: アプリ起動時や設定変更時に呼び出し */
  apply(theme: UserPrefs['theme'], accent?: string) {
    const root = document.documentElement; // <html>
    root.classList.remove('theme-light', 'theme-dark');

    const resolved =
      theme === 'system'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme;

    root.classList.add(`theme-${resolved}`);

    // アクセント色の下地（styles.scss で var(--accent) を使えるように）
    if (accent) {
      root.style.setProperty('--accent', accent);
    }
  }
}
