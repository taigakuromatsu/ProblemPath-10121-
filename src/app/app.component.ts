import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header style="display:flex;gap:12px;align-items:center;padding:8px 12px;border-bottom:1px solid #333;">
      <strong>ProblemPath</strong>
      <a routerLink="/">Home</a>
      <a routerLink="/tree">Tree</a>
      <a routerLink="/board">Board</a>
      <a routerLink="/schedule">Schedule</a>
    </header>
    <main style="padding:16px;">
      <router-outlet></router-outlet>
    </main>
  `
})
export class AppComponent {}
