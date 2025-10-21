// src/app/app.ts
import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { ProjectSwitcher } from './project-switcher';
import { ThemeService } from './services/theme.service';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, ProjectSwitcher],
  template: `
    <header style="
      position: sticky; top: 0;
      z-index: 1000; background:#fff;
      display:flex; gap:12px; align-items:center;
      padding:8px 12px; border-bottom:1px solid #eee;">
      <strong>ProblemPath</strong>
      <a routerLink="/">Home</a>
      <a routerLink="/tree">Tree</a>
      <a routerLink="/board">Board</a>
      <a routerLink="/schedule">Schedule</a>
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
  ngOnInit() {
    this.theme.init();
  }
}


