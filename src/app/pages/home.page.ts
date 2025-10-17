import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, JsonPipe } from '@angular/common';
import { PrefsService } from '../services/prefs.service';
import { ThemeService } from '../services/theme.service';

@Component({
  standalone: true,
  selector: 'pp-home',
  imports: [RouterLink, AsyncPipe, JsonPipe],
  template: `
    <h2>Home</h2>
    <p>動線の確認ページです。（設定UIは今後追加）</p>

    <nav>
      <a routerLink="/tree">🌳 Tree</a> |
      <a routerLink="/board">📋 Board</a> |
      <a routerLink="/schedule">📆 Schedule</a>
    </nav>

    <section style="margin-top:16px;">
      <h3>Settings (準備のみ／表示)</h3>
      <p style="opacity:.75; margin:0 0 8px;">
        将来ここで「性格タイプ／言語／テーマ／アクセント色」を編集します。今は下地だけ入っています。
      </p>

      <!-- 現在の設定の表示（将来フォームに置き換え予定） -->
      <pre style="padding:8px; border:1px solid #eee; border-radius:8px; background:#fafafa;">
{{ (prefs.prefs$ | async) | json }}
      </pre>
    </section>
  `
})
export class HomePage {
  constructor(public prefs: PrefsService, private theme: ThemeService) {}

  ngOnInit() {
    // 現状は“表示のみ”。将来、更新時にも反映されるよう購読継続。
    this.prefs.prefs$.subscribe(p => {
      this.theme.apply(p.theme, p.accentColor);
    });
  }
}


