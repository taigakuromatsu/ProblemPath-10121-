import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

const KEY = 'pp.currentProjectId';

@Injectable({ providedIn: 'root' })
export class CurrentProjectService {
  private id$ = new BehaviorSubject<string | null>(localStorage.getItem(KEY));
  readonly projectId$ = this.id$.asObservable();
  getSync(): string | null { return this.id$.value; }

  set(id: string | null) {
    this.id$.next(id);
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  }
  requireId(): string {
    const v = this.id$.value;
    if (!v) throw new Error('No projectId selected');
    return v;
  }
}
