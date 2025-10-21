import { Routes } from '@angular/router';
import { HomePage } from './pages/home.page';
import { TreePage } from './pages/tree.page';
import { BoardPage } from './pages/board.page';
import { SchedulePage } from './pages/schedule.page';
import { MyTasksPage } from './pages/my-tasks.page';
import { authGuard } from './guards/auth.guard'; // ← 追加


export const routes: Routes = [
  { path: '', component: HomePage },                                   // Home は誰でもOK
  { path: 'tree', component: TreePage, canActivate: [authGuard] },     // ← ログイン必須
  { path: 'board', component: BoardPage, canActivate: [authGuard] },   // ← ログイン必須
  { path: 'schedule', component: SchedulePage, canActivate: [authGuard] }, // ← ログイン必須
  { path: 'my', component: MyTasksPage, canActivate: [authGuard] } // ← ログイン必須
];
