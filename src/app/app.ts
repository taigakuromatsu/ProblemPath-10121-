import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { AsyncPipe, NgFor, NgIf } from '@angular/common';
import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';

import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

import { ProjectSwitcher } from './project-switcher';
import { ThemeService } from './services/theme.service';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [
    AsyncPipe, NgFor, NgIf,
    RouterOutlet, RouterLink, RouterLinkActive,
    MatSidenavModule, MatToolbarModule, MatIconModule, MatButtonModule,
    ProjectSwitcher, TranslateModule
  ],
  template: `
    <mat-sidenav-container class="shell">
      <mat-sidenav
        #drawer
        class="shell__sidenav"
        [mode]="(isHandset$ | async) ? 'over' : 'side'"
        [opened]="!(isHandset$ | async)"
        [autoFocus]="false"
      >
        <div class="sidenav__wrapper">
          <div class="sidenav__header">
            <mat-icon>view_kanban</mat-icon>
            <span>ProblemPath</span>
          </div>
          <pp-project-switcher></pp-project-switcher>
        </div>
      </mat-sidenav>

      <mat-sidenav-content class="shell__content">
        <mat-toolbar color="primary" class="topbar">
          <button
            mat-icon-button
            class="menu-button"
            (click)="drawer.toggle()"
            *ngIf="isHandset$ | async"
            aria-label="Toggle navigation"
          >
            <mat-icon>menu</mat-icon>
          </button>

          <div class="brand">
            <mat-icon>view_kanban</mat-icon>
            <span>ProblemPath</span>
          </div>

          <nav class="topnav">
            <a
              mat-button
              *ngFor="let link of navLinks"
              [routerLink]="link.path"
              routerLinkActive="active"
              [routerLinkActiveOptions]="{ exact: link.exact }"
            >
              {{ link.label | translate }}
            </a>
          </nav>

          <span class="spacer"></span>

          <div class="topbar-actions" aria-hidden="true">
            <button mat-stroked-button type="button" class="filter-placeholder" disabled>
              <mat-icon>tune</mat-icon>
              <span>{{ 'common.filter' | translate }}</span>
            </button>
          </div>
        </mat-toolbar>

        <div class="content-area">
          <router-outlet></router-outlet>
        </div>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `
})
export class App {
  readonly navLinks = [
    { label: 'nav.home', path: '/', exact: true },
    { label: 'nav.tree', path: '/tree', exact: false },
    { label: 'nav.board', path: '/board', exact: false },
    { label: 'nav.schedule', path: '/schedule', exact: false },
    { label: 'nav.my', path: '/my', exact: false }
  ];

  readonly isHandset$: Observable<boolean>;

  constructor(private theme: ThemeService, private breakpoint: BreakpointObserver) {
    this.isHandset$ = this.breakpoint.observe(Breakpoints.Handset).pipe(map(result => result.matches));
  }

  ngOnInit() {
    this.theme.init();
  }
}
