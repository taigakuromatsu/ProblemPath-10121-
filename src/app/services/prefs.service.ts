import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { UserPrefs } from '../models/types';

const KEY = 'pp_prefs';
const DEFAULT: UserPrefs = {
  personality: 'pragmatic',
  lang: 'ja',
  theme: 'system',
};

@Injectable({ providedIn: 'root' })
export class PrefsService {
  private state = new BehaviorSubject<UserPrefs>(this.load());
  /** 設定の購読ストリーム（Homeなどから表示用に使う） */
  prefs$ = this.state.asObservable();

  /** 現在値（必要なときに直接参照） */
  get value(): UserPrefs {
    return this.state.value;
  }

  /** 更新（将来、フォームから呼ぶ予定） */
  update(patch: Partial<UserPrefs>) {
    const next = { ...this.state.value, ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
    this.state.next(next);
  }

  private load(): UserPrefs {
    try {
      const raw = localStorage.getItem(KEY);
      return { ...DEFAULT, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      return DEFAULT;
    }
  }
}
