
// src/app/app.config.ts
import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection, importProvidersFrom, APP_INITIALIZER } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { provideHttpClient, withFetch, HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateLoader } from '@ngx-translate/core';
import { I18nService } from './i18n/i18n.service';
import { provideStorage, getStorage } from '@angular/fire/storage';
import { provideMessaging, getMessaging, } from '@angular/fire/messaging';
import { provideFunctions, getFunctions } from '@angular/fire/functions';
// loader はそのまま
class SimpleHttpTranslateLoader implements TranslateLoader {
  constructor(private http: HttpClient) {}
  getTranslation(lang: string) {
    return this.http.get<Record<string, any>>(`i18n/${lang}.json`);
  }
}
export function simpleHttpLoaderFactory(http: HttpClient): TranslateLoader {
  return new SimpleHttpTranslateLoader(http);
}

// ★ I18nService を必ず起動させる（中身は no-op でOK）
function initI18n(_i18n: I18nService) { return () => void 0; }

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    provideStorage(() => getStorage()),
    provideMessaging(() => getMessaging()),
    provideFunctions(() => getFunctions(undefined, 'asia-northeast1')),

    importProvidersFrom(
      TranslateModule.forRoot({
        // deprecate 対応：defaultLanguage / useDefaultLang は使わない
        fallbackLang: 'ja',
        loader: {
          provide: TranslateLoader,
          useFactory: simpleHttpLoaderFactory,
          deps: [HttpClient],
        },
      })
    ),

    I18nService,
    { provide: APP_INITIALIZER, useFactory: initI18n, deps: [I18nService], multi: true },
  ]
};


