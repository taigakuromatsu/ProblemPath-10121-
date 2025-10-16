import { Routes } from '@angular/router';
import { HomePage } from './pages/home.page';
import { TreePage } from './pages/tree.page';
import { BoardPage } from './pages/board.page';
import { SchedulePage } from './pages/schedule.page';

export const routes: Routes = [
  { path: '', component: HomePage },       // HomePage 用のルート
  { path: 'tree', component: TreePage },   // TreePage 用のルート
  { path: 'board', component: BoardPage }, // BoardPage 用のルート
  { path: 'schedule', component: SchedulePage }, // SchedulePage 用のルート
];
