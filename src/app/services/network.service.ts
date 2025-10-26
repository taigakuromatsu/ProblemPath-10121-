import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, fromEvent, merge, of } from 'rxjs';
import { map, startWith, distinctUntilChanged, shareReplay } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class NetworkService {
  /** true=オンライン / false=オフライン */
  private _online$ = new BehaviorSubject<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  readonly isOnline$ = this._online$.asObservable().pipe(distinctUntilChanged(), shareReplay(1));

  constructor(private zone: NgZone) {
    // online/offline イベントを購読
    const online$  = fromEvent(window, 'online').pipe(map(() => true));
    const offline$ = fromEvent(window, 'offline').pipe(map(() => false));

    merge(online$, offline$)
      .pipe(startWith(navigator.onLine))
      .subscribe(v => this.zone.run(() => this._online$.next(v)));
  }

  /** 現在値同期版（簡便ユース） */
  getSync(): boolean { return this._online$.getValue(); }
}
