import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { PrefsService } from '../services/prefs.service';
import { map, distinctUntilChanged } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly translate = inject(TranslateService);
  private readonly prefs = inject(PrefsService);

  constructor() {
    this.translate.addLangs(['ja', 'en']);

    // 初期値 & 変更を購読
    this.prefs.prefs$
      .pipe(
        map(p => (p?.lang === 'en' ? 'en' : 'ja')),
        distinctUntilChanged()
      )
      .subscribe(lang => this.useSafe(lang));

      this.useSafe('ja');
  }

  private useSafe(lang: 'ja' | 'en') {
    if (this.translate.currentLang !== lang) {
      this.translate.use(lang);
      document.documentElement.setAttribute('lang', lang);
    }
  }
}

