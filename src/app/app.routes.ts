// src/app/app.routes.ts
import { Routes } from '@angular/router';
import { HomePage } from './pages/home.page';
import { TreePage } from './pages/tree.page';
import { BoardPage } from './pages/board.page';
import { SchedulePage } from './pages/schedule.page';
import { MyTasksPage } from './pages/my-tasks.page';
import { JoinPage } from './pages/join.page';
import { AnalyticsPage } from './pages/analytics.page';
import { ReportsPage } from './pages/reports.page';

// 既存のログイン必須
import { authGuard } from './guards/auth.guard';
// 追加：プロジェクト必須
import { projectGuard } from './guards/project.guard';

export const routes: Routes = [
  { path: '', component: HomePage }, // Home は誰でもOK

  // ▼ プロジェクト前提ページは authGuard + projectGuard を併用
  { path: 'tree',      component: TreePage,      canActivate: [authGuard, projectGuard] },
  { path: 'board',     component: BoardPage,     canActivate: [authGuard, projectGuard] },
  { path: 'schedule',  component: SchedulePage,  canActivate: [authGuard, projectGuard] },
  { path: 'my',        component: MyTasksPage,   canActivate: [authGuard, projectGuard] },
  { path: 'analytics', component: AnalyticsPage, canActivate: [authGuard, projectGuard] },
  { path: 'reports',   component: ReportsPage,   canActivate: [authGuard, projectGuard] },

  // 招待リンクは誰でも開ける
  { path: 'join', component: JoinPage },
];

