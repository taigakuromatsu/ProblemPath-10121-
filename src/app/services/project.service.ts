import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

const KEY = 'pp.activeProjectId';

@Injectable({ providedIn: 'root' })
export class ProjectsService {
  readonly activeProjectId$ = new BehaviorSubject<string | null>(localStorage.getItem(KEY));

  setActiveProjectId(pid: string) {
    localStorage.setItem(KEY, pid);
    this.activeProjectId$.next(pid);
  }

  clearActiveProjectId() {
    localStorage.removeItem(KEY);
    this.activeProjectId$.next(null);
  }

  getActiveProjectIdSync(): string | null {
    return this.activeProjectId$.value;
  }
}
