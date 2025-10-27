import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { ProjectSwitcher } from './project-switcher';
import { ThemeService } from './services/theme.service';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, ProjectSwitcher, TranslateModule],
  template: `
    <header style="
      position: sticky; top: 0;
      z-index: 1000; background:#fff;
      display:flex; gap:12px; align-items:center;
      padding:8px 12px; border-bottom:1px solid #eee;">
      <strong>ProblemPath</strong>
      <a routerLink="/">{{ 'nav.home' | translate }}</a>
      <a routerLink="/tree">{{ 'nav.tree' | translate }}</a>
      <a routerLink="/board">{{ 'nav.board' | translate }}</a>
      <a routerLink="/schedule">{{ 'nav.schedule' | translate }}</a>
      <a routerLink="/my">{{ 'nav.my' | translate }}</a>
      <span style="flex:1 1 auto;"></span>
      <pp-project-switcher></pp-project-switcher>
    </header>

    <main style="padding:16px;">
      <router-outlet></router-outlet>
    </main>
  `
})
export class App {
  constructor(private theme: ThemeService) {}
  ngOnInit() { this.theme.init(); }
}



