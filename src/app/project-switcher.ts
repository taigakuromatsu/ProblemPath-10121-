// src/app/project-switcher.ts
import { Component, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';

import { CurrentProjectService } from './services/current-project.service';
import { ProjectDirectoryService, MyProject } from './services/project-directory.service';
import { AuthService } from './services/auth.service';           // ← ここを使う
import { firstValueFrom } from 'rxjs';

@Component({
  standalone: true,
  selector: 'pp-project-switcher',
  imports: [CommonModule, FormsModule, MatSelectModule, MatFormFieldModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-form-field appearance="outline" style="min-width:240px;">
      <mat-label>Project</mat-label>
      <mat-select
        [(ngModel)]="selected"
        (ngModelChange)="onChange($event)"
        [disabled]="loading || !projects.length"
      >
        <mat-option *ngIf="loading" [disabled]="true">Loading...</mat-option>
        <ng-container *ngIf="!loading && projects.length; else noItems">
          <mat-option *ngFor="let p of projects" [value]="p.pid">
            {{ p.name }} — {{ p.role }}
          </mat-option>
        </ng-container>
      </mat-select>
    </mat-form-field>

    <ng-template #noItems>
      <mat-option [disabled]="true">No projects</mat-option>
    </ng-template>
  `
})
export class ProjectSwitcher {
  projects: MyProject[] = [];
  selected: string | null = null;
  loading = true;

  constructor(
    private current: CurrentProjectService,
    private dir: ProjectDirectoryService,
    private authSvc: AuthService,     // ← Auth 直読みをやめてこれ
  ) {}

  async ngOnInit() {
    const uid = await firstValueFrom(this.authSvc.uid$);  // ← 認証確定を待つ
    if (!uid) { this.loading = false; return; }

    this.projects = await this.dir.listMine(uid);
    this.loading = false;

    const curr = this.current.getSync();
    if (curr && this.projects.some(p => p.pid === curr)) {
      this.selected = curr;
    } else {
      this.selected = this.projects[0]?.pid ?? null;
      if (this.selected) this.current.set(this.selected);
    }
  }

  onChange(pid: string | null) {
    this.current.set(pid);
  }
}

