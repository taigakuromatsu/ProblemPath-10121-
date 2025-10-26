// src/app/services/drafts.service.ts
import { Injectable } from '@angular/core';

type DraftRecord<T> = { value: T; updatedAt: number };

@Injectable({ providedIn: 'root' })
export class DraftsService {
  private ns = 'pp.draft';

  set<T>(key: string, value: T | null | undefined) {
    try {
      if (value == null || (typeof value === 'string' && value.trim() === '')) {
        localStorage.removeItem(this.k(key));
        return;
      }
      const rec: DraftRecord<T> = { value, updatedAt: Date.now() };
      localStorage.setItem(this.k(key), JSON.stringify(rec));
    } catch {}
  }

  get<T>(key: string): DraftRecord<T> | null {
    try {
      const raw = localStorage.getItem(this.k(key));
      if (!raw) return null;
      return JSON.parse(raw) as DraftRecord<T>;
    } catch { return null; }
  }

  clear(key: string) { localStorage.removeItem(this.k(key)); }

  private k(key: string) { return `${this.ns}:${key}`; }
}
