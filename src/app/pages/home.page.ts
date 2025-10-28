// src/app/pages/home.page.ts
import { Component, DestroyRef, OnInit, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, NgFor, NgIf, JsonPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PrefsService } from '../services/prefs.service';
import { ThemeService } from '../services/theme.service';
import { ProblemsService } from '../services/problems.service';
import { IssuesService } from '../services/issues.service';
import { TasksService } from '../services/tasks.service';
import { CurrentProjectService } from '../services/current-project.service';
import { AuthService } from '../services/auth.service';
import { MembersService } from '../services/members.service';
import { InvitesService, InviteRole } from '../services/invites.service';
import { Problem, Issue, Task } from '../models/types';
import { Observable, BehaviorSubject, of, combineLatest, firstValueFrom, Subscription } from 'rxjs';
import { switchMap, take, map, startWith } from 'rxjs/operators';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { serverTimestamp } from 'firebase/firestore';
import { DraftsService } from '../services/drafts.service';
import { NetworkService } from '../services/network.service';
import { TranslateModule } from '@ngx-translate/core';
import { MessagingService } from '../services/messaging.service';

// ★ 追加：AngularFire Firestore（トークン保存に使用）
import { Firestore, doc, setDoc } from '@angular/fire/firestore';

// ---- このページ専用の拡張型 ----
type ProblemWithDef = Problem & {
  problemDef?: {
    phenomenon: string;
    goal: string;
    cause?: string;
    solution?: string;
    updatedAt?: any;
    updatedBy?: string;
  };
};
type EditProblemField = 'phenomenon' | 'cause' | 'solution' | 'goal';

// ---- リンク種別 ----
type LinkType = 'relates' | 'duplicate' | 'blocks' | 'depends_on' | 'same_cause';
const LINK_TYPE_LABEL: Record<LinkType, string> = {
  relates: '関連',
  duplicate: '重複',
  blocks: 'ブロック',
  depends_on: '依存',
  same_cause: '同一原因',
};

@Component({
  standalone: true,
  selector: 'pp-home',
  imports: [
    RouterLink, AsyncPipe, NgFor, NgIf, JsonPipe, DatePipe, FormsModule,
    MatButtonModule, MatSelectModule, MatFormFieldModule, MatIconModule, MatSnackBarModule, TranslateModule
  ],
  template: `
      <h2>{{ 'home.title' | translate }}</h2>

    <div style="display:flex; align-items:center; gap:12px; margin:8px 0;">
      <span style="flex:1 1 auto;"></span>
      <ng-container *ngIf="auth.loggedIn$ | async; else signin">
        <span style="opacity:.8; margin-right:6px;">{{ (auth.displayName$ | async) || ('auth.signedIn' | translate) }}</span>
        <button mat-stroked-button type="button" (click)="auth.signOut()">{{ 'auth.signOut' | translate }}</button>
      </ng-container>
      <ng-template #signin>
        <button mat-raised-button color="primary" type="button" (click)="auth.signInWithGoogle()">{{ 'auth.signInWithGoogle' | translate }}</button>
        <button mat-stroked-button type="button" (click)="switchAccount()">{{ 'auth.switchAccount' | translate }}</button>
      </ng-template>
    </div>

    <!-- オフライン注意 -->
    <div *ngIf="(auth.loggedIn$ | async) && !(isOnline$ | async)"
         style="padding:8px 10px; border:1px solid #fca5a5; border-radius:8px; background:#fff1f2; margin:8px 0; font-size:12px; color:#991b1b;">
      {{ 'warn.offlineEditBlocked' | translate }}
    </div>

    <div *ngIf="(auth.loggedIn$ | async) && !(members.isEditor$ | async)"
         style="padding:8px 10px; border:1px solid #e5e7eb; border-radius:8px; background:#fafafa; margin:8px 0; font-size:12px;">
      {{ 'warn.viewerOnly' | translate }}
    </div>

    <!-- 通知（FCM）: 権限リクエスト＆受信一覧 -->
    <div *ngIf="auth.loggedIn$ | async" style="padding:10px; border:1px solid #e5e7eb; border-radius:10px; margin:12px 0;">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <button mat-raised-button color="primary" type="button" (click)="askNotificationPermission()">
          通知を有効化（権限リクエスト）
        </button>
        <span *ngIf="fcmToken" style="font-size:12px; opacity:.8; word-break:break-all;">
          Token: {{ fcmToken }}
        </span>
      </div>
      <div style="margin-top:8px;">
        <h4 style="margin:0 0 6px;">最新通知（フォアグラウンド）</h4>
        <div *ngIf="fgMessages.length === 0" style="opacity:.7;">（まだありません）</div>
        <ul>
          <li *ngFor="let m of fgMessages">
            <strong>{{ m.title || '通知' }}</strong> — {{ m.body || '' }}
          </li>
        </ul>
      </div>
    </div>

    <p>{{ 'home.lead' | translate }}</p>

    <ng-container *ngIf="auth.loggedIn$ | async; then editor; else needSignIn"></ng-container>

    <ng-template #needSignIn>
      <div style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin:12px 0;">
        {{ 'home.needSignIn' | translate }}<br>
        {{ 'home.viewOnlyHint' | translate }}
        <!-- 参照リンクのラベル -->
        (<a routerLink="/tree">{{ 'nav.tree' | translate }}</a> / <a routerLink="/board">{{ 'nav.board' | translate }}</a> / <a routerLink="/schedule">{{ 'nav.schedule' | translate }}</a>)
      </div>
    </ng-template>

    <ng-template #editor>
      <nav style="margin-bottom:12px;">
        <a routerLink="/tree">🌳 {{ 'nav.tree' | translate }}</a> |
        <a routerLink="/board">📋 {{ 'nav.board' | translate }}</a> |
        <a routerLink="/schedule">📆 {{ 'nav.schedule' | translate }}</a>
      </nav>

      <!-- 問題セレクト -->
      <div style="display:flex; align-items:center; gap:12px; margin:8px 0 12px;">
        <label>{{ 'label.problem' | translate }}：
          <select [(ngModel)]="selectedProblemId" (ngModelChange)="onSelectProblem($event)">
            <option [ngValue]="null">{{ 'common.selectPrompt' | translate }}</option>
            <option *ngFor="let p of (problems$ | async)" [ngValue]="p.id">{{ p.title }}</option>
            <option *ngIf="members.isEditor$ | async" [ngValue]="NEW_OPTION_VALUE">＋ {{ 'common.createNewEllipsis' | translate }}</option>
          </select>
        </label>

        <!-- 新規 問題 作成モーダル -->
        <div *ngIf="newProblemOpen"
            style="position:fixed; inset:0; display:grid; place-items:center; background:rgba(0,0,0,.35); z-index:1000;">
          <div style="width:min(720px, 92vw); background:#fff; color:#111; border-radius:12px; padding:14px 16px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <h3 style="margin:0; font-size:16px;">{{ 'problem.create' | translate }}</h3>
              <span style="flex:1 1 auto"></span>
              <button mat-icon-button (click)="closeNewProblemDialog()"><mat-icon>close</mat-icon></button>
            </div>

            <div style="display:grid; gap:10px;">
              <div>
                <label>{{ 'field.titleRequired' | translate }}</label>
                <input
                  [(ngModel)]="newProblem.title"
                  (ngModelChange)="onNewProblemChange('title', newProblem.title)"
                  style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;" />
              </div>

              <div style="display:flex; gap:8px; align-items:center;">
                <label>{{ 'field.template' | translate }}</label>
                <select
                  [(ngModel)]="newProblem.template"
                  (ngModelChange)="applyProblemTemplate($event); onNewProblemChange('template', newProblem.template)">
                  <option value="bug">{{ 'template.bug' | translate }}</option>
                  <option value="improve">{{ 'template.improve' | translate }}</option>
                </select>
              </div>

              <div>
                <label>{{ 'problem.phenomenonRequired' | translate }}</label>
                <textarea rows="3" [(ngModel)]="newProblem.phenomenon"
                          (ngModelChange)="onNewProblemChange('phenomenon', newProblem.phenomenon)"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
                <div style="opacity:.7; font-size:12px; margin-top:4px;">
                  {{ 'hint.phenomenon' | translate }}
                </div>
              </div>

              <div>
                <label>{{ 'problem.causeOptional' | translate }}</label>
                <textarea rows="3" [(ngModel)]="newProblem.cause"
                          (ngModelChange)="onNewProblemChange('cause', newProblem.cause)"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>{{ 'problem.solutionOptional' | translate }}</label>
                <textarea rows="3" [(ngModel)]="newProblem.solution"
                          (ngModelChange)="onNewProblemChange('solution', newProblem.solution)"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>{{ 'problem.goalRequired' | translate }}</label>
                <textarea rows="2" [(ngModel)]="newProblem.goal"
                          (ngModelChange)="onNewProblemChange('goal', newProblem.goal)"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
                <div style="opacity:.7; font-size:12px; margin-top:4px;">
                  {{ 'hint.goalKpi' | translate }}
                </div>
              </div>

              <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:4px;">
                <button mat-stroked-button (click)="closeNewProblemDialog()">{{ 'common.cancel' | translate }}</button>
                <button mat-raised-button color="primary" (click)="createProblemWithDefinition()"
                        [disabled]="!(canEdit$ | async)">
                  {{ 'common.create' | translate }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 問題定義：編集モーダル -->
        <div *ngIf="editProblemOpen"
            style="position:fixed; inset:0; display:grid; place-items:center; background:rgba(0,0,0,.35); z-index:1000;">
          <div style="width:min(720px, 92vw); background:#fff; color:#111; border-radius:12px; padding:14px 16px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <h3 style="margin:0; font-size:16px;">{{ 'problemDef.edit' | translate }}</h3>
              <span style="flex:1 1 auto"></span>
              <button mat-icon-button (click)="closeEditProblemDialog()"><mat-icon>close</mat-icon></button>
            </div>

            <div style="display:grid; gap:10px;">
              <div>
                <label>{{ 'field.titleReadonly' | translate }}</label>
                <input [value]="editProblem.title" readonly
                      style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px; background:#f7f7f7;">
              </div>

              <div>
                <label>{{ 'problem.phenomenonRequired' | translate }}</label>
                <textarea rows="3" [(ngModel)]="editProblem.phenomenon"
                          (ngModelChange)="onEditProblemChange('phenomenon', editProblem.phenomenon)"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>{{ 'problem.causeOptional' | translate }}</label>
                <textarea rows="3" [(ngModel)]="editProblem.cause"
                          (ngModelChange)="onEditProblemChange('cause', editProblem.cause)"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>{{ 'problem.solutionOptional' | translate }}</label>
                <textarea rows="3" [(ngModel)]="editProblem.solution"
                          (ngModelChange)="onEditProblemChange('solution', editProblem.solution)"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div>
                <label>{{ 'problem.goalRequired' | translate }}</label>
                <textarea rows="2" [(ngModel)]="editProblem.goal"
                          (ngModelChange)="onEditProblemChange('goal', editProblem.goal)"
                          style="width:100%; padding:6px; border:1px solid #e5e7eb; border-radius:6px;"></textarea>
              </div>

              <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:4px;">
                <button mat-stroked-button (click)="closeEditProblemDialog()">{{ 'common.cancel' | translate }}</button>
                <button mat-raised-button color="primary" (click)="saveEditedProblemDef()"
                        [disabled]="!(canEdit$ | async)">
                  {{ 'common.save' | translate }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <span style="flex:1 1 auto"></span>

        <ng-container *ngIf="members.isEditor$ | async">
          <button *ngIf="selectedProblemId" mat-stroked-button (click)="renameSelected()"
                  [disabled]="!(canEdit$ | async)">{{ 'common.rename' | translate }}</button>
          <button *ngIf="selectedProblemId" mat-stroked-button color="warn" (click)="removeSelected()"
                  [disabled]="!(canEdit$ | async)">{{ 'common.delete' | translate }}</button>
        </ng-container>
      </div>

      <!-- 選択中の問題の情報 -->
      <ng-container *ngIf="selectedProblemId as pid">
        <div *ngIf="selectedProblemDoc$ | async as p"
             style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:12px;">
          <h3 style="margin:0 0 8px; display:flex; align-items:center; gap:8px;">
            <span>{{ 'problemDef.title' | translate }}</span>
            <span style="flex:1 1 auto;"></span>
            <button *ngIf="members.isEditor$ | async"
                    mat-stroked-button
                    (click)="openEditProblemDef(p)">
              {{ 'common.edit' | translate }}
            </button>
          </h3>
          <div style="display:grid; gap:6px; font-size:14px;">
            <div><span style="font-weight:600;">{{ 'field.phenomenon' | translate }}：</span>
              <span>{{ p.problemDef?.phenomenon || '—' }}</span>
            </div>
            <div *ngIf="p.problemDef?.cause"><span style="font-weight:600;">{{ 'field.cause' | translate }}：</span>
              <span>{{ p.problemDef?.cause }}</span>
            </div>
            <div *ngIf="p.problemDef?.solution"><span style="font-weight:600;">{{ 'field.solution' | translate }}：</span>
              <span>{{ p.problemDef?.solution }}</span>
            </div>
            <div><span style="font-weight:600;">{{ 'field.goal' | translate }}：</span>
              <span>{{ p.problemDef?.goal || '—' }}</span>
            </div>
            <div style="opacity:.65; font-size:12px; margin-top:4px;"
                *ngIf="getUpdatedAtDate(p) as d">
              {{ 'common.lastUpdated' | translate }}：{{ d | date:'yyyy/MM/dd HH:mm' }}
            </div>
          </div>
        </div>

        <!-- 課題 + リンク UI -->
        <div style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:16px;">
          <h3 style="margin:0 0 8px;">{{ 'issue.listTitle' | translate }}</h3>

          <form *ngIf="members.isEditor$ | async"
                (ngSubmit)="createIssue(pid)"
                style="display:flex; gap:8px; align-items:center; margin:8px 0;">
            <input [(ngModel)]="issueTitle" name="issueTitle" [placeholder]="'issue.placeholderNewTitle' | translate"
                   required (ngModelChange)="onIssueTitleChange($event)" />
            <button mat-raised-button color="primary" type="submit"
                    [disabled]="!(canEdit$ | async)">＋ {{ 'issue.add' | translate }}</button>
          </form>

          <ul *ngIf="issues$ | async as issues; else loadingIssues" style="margin:0; padding-left:1rem;">
            <li *ngFor="let i of issues" style="margin-bottom:12px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <strong>{{ i.title }}</strong>
                <span style="flex:1 1 auto"></span>
                <ng-container *ngIf="members.isEditor$ | async">
                  <button mat-button (click)="renameIssue(pid, i)" [disabled]="!(canEdit$ | async)">{{ 'common.rename' | translate }}</button>
                  <button mat-button color="warn" (click)="removeIssue(pid, i)" [disabled]="!(canEdit$ | async)">{{ 'common.delete' | translate }}</button>
                </ng-container>
              </div>

              <!-- リンク一覧 -->
              <div style="margin:6px 0 2px 0; font-size:13px;">
                <span style="font-weight:600;">{{ 'link.title' | translate }}：</span>
                <ng-container *ngIf="(visibleLinks(i.links, issues).length) > 0; else noLinks">
                  <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:4px;">
                    <ng-container *ngFor="let lk of visibleLinks(i.links, issues)">
                      <span style="border:1px solid #e5e7eb; border-radius:999px; padding:2px 8px; background:#fafafa;">
                        <span style="opacity:.85;">[{{ linkLabel(lk.type) }}]</span>
                        <span> {{ titleByIssueId(issues, lk.issueId) }} </span>
                        <button *ngIf="members.isEditor$ | async"
                                mat-icon-button
                                aria-label="{{ 'link.removeAria' | translate }}"
                                (click)="onRemoveLink(pid, i.id!, lk.issueId, lk.type)"
                                [disabled]="!(canEdit$ | async)"
                                style="vertical-align:middle; margin-left:2px;">
                          <mat-icon style="font-size:16px;">close</mat-icon>
                        </button>
                      </span>
                    </ng-container>
                  </div>
                </ng-container>
                <ng-template #noLinks><span style="opacity:.7;">{{ 'link.none' | translate }}</span></ng-template>
              </div>

              <!-- リンク追加フォーム（編集者のみ） -->
              <form *ngIf="members.isEditor$ | async"
                    (ngSubmit)="onAddLink(pid, i.id!)"
                    style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0 4px 0;">
                <select [(ngModel)]="linkTarget[i.id!]" name="linkTarget-{{i.id}}" style="min-width:180px;">
                  <option [ngValue]="null">{{ 'link.selectIssuePrompt' | translate }}</option>
                  <option *ngFor="let j of issues" [ngValue]="j.id" [disabled]="j.id===i.id">
                    {{ j.title }}
                  </option>
                </select>
                <select [(ngModel)]="linkTypeSel[i.id!]" name="linkType-{{i.id}}" style="min-width:140px;">
                  <option *ngFor="let t of linkTypes" [ngValue]="t">{{ linkLabel(t) }}</option>
                </select>
                <button mat-stroked-button type="submit" [disabled]="!(canEdit$ | async)">＋ {{ 'link.add' | translate }}</button>
              </form>

              <!-- タスク -->
              <form *ngIf="members.isEditor$ | async"
                    (ngSubmit)="createTask(pid, i.id!)"
                    style="display:flex; gap:6px; margin:6px 0 4px 0;">
                <input [(ngModel)]="taskTitle[i.id!]" name="taskTitle-{{i.id}}" [placeholder]="'task.placeholderNewTitle' | translate"
                       required (ngModelChange)="onTaskTitleChange(i.id!, taskTitle[i.id!])" />
                <button mat-stroked-button type="submit" [disabled]="!(canEdit$ | async)">＋ {{ 'task.add' | translate }}</button>
              </form>

              <ul *ngIf="tasksMap[i.id!] | async as tasks" style="margin:0; padding-left:1rem;">
                <li *ngFor="let t of tasks" style="margin:3px 0;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <span style="flex:1 1 auto;">
                      {{ t.title }}
                      <span *ngIf="t.dueDate" style="font-size:12px; opacity:.8; margin-left:6px;">{{ 'task.dueShort' | translate:{ date: t.dueDate } }}</span>
                      <span style="font-size:12px; opacity:.85; margin-left:6px;">
                        <ng-container *ngIf="(t.tags?.length ?? 0) > 0; else noTags">
                          #{{ t.tags!.join(' #') }}
                        </ng-container>
                        <ng-template #noTags>{{ 'tag.none' | translate }}</ng-template>
                      </span>
                    </span>

                    <ng-container *ngIf="members.isEditor$ | async">
                      <button mat-button (click)="renameTask(pid, i.id!, t)" [disabled]="!(canEdit$ | async)">{{ 'common.rename' | translate }}</button>
                      <button mat-button (click)="editTaskDue(pid, i.id!, t)" [disabled]="!(canEdit$ | async)">{{ 'task.editDue' | translate }}</button>
                      <button mat-button (click)="editTaskTags(pid, i.id!, t)" [disabled]="!(canEdit$ | async)">{{ 'task.editTags' | translate }}</button>
                      <button mat-button color="warn" (click)="removeTask(pid, i.id!, t)" [disabled]="!(canEdit$ | async)">{{ 'common.delete' | translate }}</button>
                    </ng-container>
                  </div>
                </li>
                <li *ngIf="tasks.length === 0" style="opacity:.7">{{ 'task.noneYet' | translate }}</li>
              </ul>
            </li>
            <li *ngIf="issues.length === 0" style="opacity:.7">{{ 'issue.noneYet' | translate }}</li>
          </ul>
          <ng-template #loadingIssues>{{ 'issue.loading' | translate }}</ng-template>
        </div>
      </ng-container>

      <!-- === 招待（Adminのみ） === -->
      <div *ngIf="(members.isAdmin$ | async)" style="padding:12px; border:1px solid #e5e7eb; border-radius:10px; margin:12px 0;">
        <h3 style="margin:0 0 8px;">{{ 'invite.byEmailTitle' | translate }}</h3>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <input [(ngModel)]="inviteEmail" placeholder="email@example.com"
                style="padding:6px 8px; border:1px solid #e5e7eb; border-radius:6px; min-width:240px;">
          <select [(ngModel)]="inviteRole">
            <option value="admin">{{ 'role.adminLabel' | translate }}</option>
            <option value="member" selected>{{ 'role.memberLabel' | translate }}</option>
            <option value="viewer">{{ 'role.viewerLabel' | translate }}</option>
          </select>
          <button mat-raised-button color="primary" (click)="createInvite()" [disabled]="isCreatingInvite || !(isOnline$ | async)">
            {{ isCreatingInvite ? ('common.creating' | translate) : ('invite.createLink' | translate) }}
          </button>
          <ng-container *ngIf="inviteUrl">
            <input [value]="inviteUrl" readonly
                  style="flex:1 1 auto; padding:6px 8px; border:1px solid #e5e7eb; border-radius:6px;">
            <button mat-stroked-button (click)="copyInviteUrl()">{{ 'common.copy' | translate }}</button>
          </ng-container>
        </div>
        <p style="opacity:.7; margin-top:6px;">{{ 'invite.helpText' | translate }}</p>
      </div>

      <!-- 設定 表示 -->
      <section style="margin-top:16px;">
        <h3>{{ 'settings.titlePreview' | translate }}</h3>
        <p style="opacity:.75; margin:0 0 8px;">
          {{ 'settings.lead' | translate }}
        </p>
        <pre style="padding:8px; border:1px solid #eee; border-radius:8px; background:#fafafa;">
{{ (prefs.prefs$ | async) | json }}
        </pre>
      </section>

      <section style="margin-top:16px;">
        <h3>{{ 'settings.languageTitle' | translate }}</h3>

        <mat-form-field appearance="outline" style="min-width:240px; width:100%; max-width:360px; margin-top:8px;">
          <mat-label>{{ 'settings.languageSelect' | translate }}</mat-label>
          <mat-select [(ngModel)]="lang" (selectionChange)="onLangChange($event.value)">
            <mat-option value="ja">日本語</mat-option>
            <mat-option value="en">English</mat-option>
          </mat-select>
          <mat-icon matSuffix>expand_more</mat-icon>
        </mat-form-field>
      </section>
      
      <!-- テーマ設定 UI -->
      <section style="margin-top:16px;">
        <h3>{{ 'settings.themeTitle' | translate }}</h3>

        <mat-form-field appearance="outline" style="min-width:240px; width:100%; max-width:360px; margin-top:8px;">
          <mat-label>{{ 'settings.themeSelect' | translate }}</mat-label>
          <mat-select [(ngModel)]="themeMode" (selectionChange)="onThemeChange($event.value)">
            <mat-option value="light">{{ 'theme.light' | translate }}</mat-option>
            <mat-option value="dark">{{ 'theme.dark' | translate }}</mat-option>
            <mat-option value="system">{{ 'theme.system' | translate }}</mat-option>
          </mat-select>
          <mat-icon matSuffix>expand_more</mat-icon>
        </mat-form-field>

      </section>

    </ng-template>

  `
})
export class HomePage implements OnInit, OnDestroy {
  readonly NEW_OPTION_VALUE = '__NEW__';

  problems$!: Observable<Problem[]>;
  selectedProblemId: string | null = null;

  private selectedProblem$ = new BehaviorSubject<string | null>(null);
  issues$: Observable<Issue[] | null> = of(null);

  // Problem 定義表示用
  selectedProblemDoc$!: Observable<ProblemWithDef | null>;

  issueTitle = '';
  taskTitle: Record<string, string> = {}; // key = issueId
  tasksMap: Record<string, Observable<Task[]>> = {};

  // Link UI state
  linkTypes: LinkType[] = ['relates','duplicate','blocks','depends_on','same_cause'];
  linkTarget: Record<string, string | null> = {};
  linkTypeSel: Record<string, LinkType> = {};

  // Draft timers
  private issueTitleTimer: any = null;
  private taskTitleTimers: Record<string, any> = {};
  private newProblemTimers: Partial<Record<'title'|'phenomenon'|'cause'|'solution'|'goal'|'template', any>> = {};
  private editProblemTimers: Partial<Record<EditProblemField, any>> = {};

  // ネットワーク
  isOnline$!: Observable<boolean>;
  canEdit$!: Observable<boolean>;

  // --- FCM（フォアグラウンド表示用） ---
  fcmToken: string | null = null;
  fgMessages: Array<{ title?: string; body?: string }> = [];
  private fgSub?: Subscription;

  constructor(
    public prefs: PrefsService,
    private theme: ThemeService,
    private problems: ProblemsService,
    private issues: IssuesService,
    private tasks: TasksService,
    private destroyRef: DestroyRef,
    public auth: AuthService,
    private currentProject: CurrentProjectService,
    public members: MembersService,
    private invites: InvitesService,
    private snack: MatSnackBar,
    private drafts: DraftsService,
    private network: NetworkService,
    private msg: MessagingService,
    // ★ 追加：Firestore（トークン保存用）
    private afs: Firestore,
  ) {
    this.isOnline$ = this.network.isOnline$;
    this.canEdit$ = combineLatest([this.members.isEditor$, this.network.isOnline$]).pipe(
      map(([isEditor, online]) => !!isEditor && !!online)
    );
  }
  
  onLangChange(next: 'ja' | 'en') {
    this.prefs.update({ lang: next });
  }

  lang: 'ja' | 'en' = 'ja';

  themeMode: 'light' | 'dark' | 'system' = 'system';

  async ngOnInit() {
    // テーマ反映
    this.prefs.prefs$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(p => {
        this.themeMode = (p?.theme ?? 'system') as any;
        this.lang = (p?.lang === 'en' ? 'en' : 'ja');
      });

    // サインアウト時の掃除
    this.auth.loggedIn$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(isIn => {
        if (!isIn) {
          this.currentProject.set(null);
          this.selectedProblemId = null;
          this.selectedProblem$.next(null);
          this.tasksMap = {};
        }
      });

    // Problems（pid 必須）
    this.problems$ = combineLatest([this.auth.loggedIn$, this.currentProject.projectId$]).pipe(
      switchMap(([isIn, pid]) => (isIn && pid && pid !== 'default') ? this.problems.list(pid) : of([]))
    );

    // 選択中 Problem の Doc
    this.selectedProblemDoc$ = combineLatest([
      this.problems$.pipe(startWith([] as Problem[])),
      this.selectedProblem$
    ]).pipe(map(([list, sel]) => (list as ProblemWithDef[]).find(p => p.id === sel) ?? null));

    // Issues（選択 Problem × pid）
    this.issues$ = combineLatest([
      this.selectedProblem$,
      this.auth.loggedIn$,
      this.currentProject.projectId$
    ]).pipe(
      switchMap(([pidProblem, isIn, pid]) =>
        (isIn && pid && pid !== 'default' && pidProblem) ? this.issues.listByProblem(pid, pidProblem) : of([])
      )
    );

    // Issue → Task購読 + ドラフト復元 + Link UI 初期化
    this.issues$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(issues => {
        if (!this.selectedProblemId) {
          this.tasksMap = {};
          return;
        }
        const nextMap: Record<string, Observable<Task[]>> = {};
        for (const i of issues ?? []) {
          const id = i.id!;
          nextMap[id] = this.tasksMap[id] ?? this.currentProject.projectId$.pipe(
            switchMap(pid => (pid && pid !== 'default') ? this.tasks.listByIssue(pid, this.selectedProblemId!, id) : of([]))
          );

          // Task タイトルのドラフト復元
          const keyT = this.draftKeyTaskTitle(this.selectedProblemId, id);
          const recT = keyT ? this.drafts.get<string>(keyT) : null;
          if (recT && !this.taskTitle[id]) {
            this.taskTitle[id] = recT.value || '';
          }

          // Link UI 初期値
          if (!this.linkTypeSel[id]) this.linkTypeSel[id] = 'relates';
          if (!(id in this.linkTarget)) this.linkTarget[id] = null;
        }
        this.tasksMap = nextMap;
      });

    // --- FCM: 既に権限があればトークン取得、保存、フォアグラウンド受信購読 ---
    try {
      this.fcmToken = await this.msg.getTokenIfGranted();
      const uid = await firstValueFrom(this.auth.uid$);
      if (uid && this.fcmToken) {
        await this.saveFcmToken(uid, this.fcmToken, /*seenOnly*/ true);
      }
    } catch {}
    this.fgSub = this.msg.onMessage$.subscribe(n => {
      this.fgMessages = [{ title: n?.title, body: n?.body }, ...this.fgMessages].slice(0, 20);
    });
  }

  // ★ 追加：FCM トークンの保存ユーティリティ
  private async saveFcmToken(uid: string, token: string, seenOnly = false) {
    const ref = doc(this.afs, `users/${uid}/fcmTokens/${token}`);
    const base = { ua: navigator.userAgent };
    if (seenOnly) {
      await setDoc(ref, { ...base, lastSeenAt: serverTimestamp() }, { merge: true });
    } else {
      await setDoc(ref, { ...base, createdAt: serverTimestamp(), lastSeenAt: serverTimestamp() }, { merge: true });
    }
  }

  // 通知の権限リクエスト → トークン取得 → Firestore 保存
  async askNotificationPermission() {
    try {
      const t = await this.msg.requestPermissionAndGetToken();
      this.fcmToken = t;
      const uid = await firstValueFrom(this.auth.uid$);
      if (uid && t) {
        await this.saveFcmToken(uid, t /* seenOnly=false で新規作成 */);
      }
      this.snack.open('通知を有効化しました', undefined, { duration: 2000 });
    } catch (e: any) {
      console.error('[FCM] permission/token error', e);
      this.snack.open('通知の有効化に失敗しました', undefined, { duration: 2500 });
    }
  }

  async switchAccount() {
    await this.auth.signOut();
    await this.auth.signInWithGoogle(true);
  }

  // 招待
  inviteEmail = '';
  inviteRole: InviteRole = 'member';
  inviteUrl: string | null = null;
  isCreatingInvite = false;

  async createInvite() {
    if (!(await this.requireOnline())) return;
    if (!this.inviteEmail.trim()) return;
    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }
    this.isCreatingInvite = true;
    try {
      const url = await this.invites.create(pid, this.inviteEmail.trim(), this.inviteRole);
      this.inviteUrl = url;
    } finally {
      this.isCreatingInvite = false;
    }
  }
  copyInviteUrl() {
    if (this.inviteUrl) navigator.clipboard.writeText(this.inviteUrl);
  }

  // テーマ
  onThemeChange(mode: 'light' | 'dark' | 'system') {
    this.theme.setTheme(mode);
    if ((this.prefs as any).update) {
      (this.prefs as any).update({ theme: mode });
    } else {
      localStorage.setItem('pp.theme', mode);
    }
    this.themeMode = mode;
  }

  get systemPrefersDark(): boolean {
    return typeof window !== 'undefined'
      && !!window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  get themeModeLabel(): string {
    if (this.themeMode === 'system') {
      return this.systemPrefersDark ? 'システム（ダーク）' : 'システム（ライト）';
    }
    return this.themeMode === 'dark' ? 'ダーク' : 'ライト';
  }

  onSelectProblem(val: string | null) {
    if (val === this.NEW_OPTION_VALUE) {
      this.selectedProblemId = null;
      this.selectedProblem$.next(null);
      this.openNewProblemDialog();
      return;
    }
    this.selectedProblemId = val;
    this.selectedProblem$.next(val);

    // Issue タイトルのドラフト復元
    const key = this.draftKeyIssueTitle(val);
    if (key) {
      const rec = this.drafts.get<string>(key);
      if (rec && !this.issueTitle) {
        const ok = confirm('Issue タイトルの下書きがあります。復元しますか？');
        if (ok) this.issueTitle = rec.value || '';
      }
    }
  }

  // 共通 withPid
  private withPid(run: (pid: string) => void) {
    this.currentProject.projectId$.pipe(take(1)).subscribe(pid => {
      if (!pid || pid === 'default') {
        alert('プロジェクト未選択');
        return;
      }
      run(pid);
    });
  }

  // オンライン必須ガード
  private async requireOnline(): Promise<boolean> {
    const online = await firstValueFrom(this.isOnline$);
    if (!online) {
      alert('オフラインのため、この操作は実行できません。接続を確認してください。');
      return false;
    }
    return true;
  }

  // --- Issue タイトルのドラフト ---
  private draftKeyIssueTitle(problemId: string | null): string | null {
    const pid = this.currentProject.getSync();
    if (!pid || !problemId) return null;
    return `issueTitle:${pid}:${problemId}`;
  }
  onIssueTitleChange(val: string) {
    if (this.issueTitleTimer) clearTimeout(this.issueTitleTimer);
    this.issueTitleTimer = setTimeout(() => {
      const key = this.draftKeyIssueTitle(this.selectedProblemId);
      if (key) this.drafts.set(key, (val ?? '').toString());
    }, 600);
  }

  // --- Problem 操作 ---
  async renameSelected() {
    if (!this.selectedProblemId) return;
    if (!(await this.requireOnline())) return;
    const t = prompt('New Problem title');
    if (!t?.trim()) return;
    this.withPid(pid => this.problems.update(pid, this.selectedProblemId!, { title: t.trim() }));
  }
  async removeSelected() {
    if (!this.selectedProblemId) return;
    if (!(await this.requireOnline())) return;
    if (!confirm('Delete this Problem (and all children)?')) return;
    const problemId = this.selectedProblemId!;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('problem', { projectId: pid, problemId }, '(Problem)');
      this.selectedProblemId = null;
      this.selectedProblem$.next(null);
    });
  }

  // --- Issue 操作 ---
  async createIssue(problemId: string) {
    if (!(await this.requireOnline())) return;
    const t = this.issueTitle.trim();
    if (!t) return;
    this.withPid(pid => this.issues.create(pid, problemId, { title: t }).then(() => {
      this.issueTitle = '';
      const key = this.draftKeyIssueTitle(this.selectedProblemId);
      if (key) this.drafts.clear(key);
    }));
  }
  async renameIssue(problemId: string, i: Issue) {
    if (!(await this.requireOnline())) return;
    const t = prompt('New Issue title', i.title);
    if (!t?.trim()) return;
    this.withPid(pid => this.issues.update(pid, problemId, i.id!, { title: t.trim() }));
  }
  async removeIssue(problemId: string, i: Issue) {
    if (!(await this.requireOnline())) return;
    if (!confirm(`Delete Issue "${i.title}"?`)) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('issue', { projectId: pid, problemId, issueId: i.id! }, i.title);
    });
  }

  // === Link 操作 ===
  linkLabel(t: LinkType) { return LINK_TYPE_LABEL[t] || t; }
  titleByIssueId(all: Issue[], id?: string | null): string | null {
    if (!id) return null;
    const hit = all?.find(x => x.id === id);
    return hit?.title ?? null;
  }
  async onAddLink(problemId: string, fromIssueId: string) {
    if (!(await this.requireOnline())) return;
    const toIssueId = this.linkTarget[fromIssueId];
    const type = this.linkTypeSel[fromIssueId] || 'relates';
    if (!toIssueId) { alert('対象 Issue を選んでください'); return; }
    if (toIssueId === fromIssueId) { alert('同一 Issue にはリンクできません'); return; }
    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }
    const uid = await firstValueFrom(this.auth.uid$);
    await this.issues.addLink(pid, problemId, fromIssueId, toIssueId, type, uid || '');
    this.linkTarget[fromIssueId] = null;
    this.linkTypeSel[fromIssueId] = 'relates';
  }
  async onRemoveLink(problemId: string, fromIssueId: string, toIssueId: string, type: LinkType) {
    if (!(await this.requireOnline())) return;
    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }
    await this.issues.removeLink(pid, problemId, fromIssueId, toIssueId, type);
  }

  // --- Task タイトルのドラフト ---
  private draftKeyTaskTitle(problemId: string | null, issueId: string): string | null {
    const pid = this.currentProject.getSync();
    if (!pid || !problemId) return null;
    return `taskTitle:${pid}:${problemId}:${issueId}`;
  }
  onTaskTitleChange(issueId: string, val: string) {
    const k = this.draftKeyTaskTitle(this.selectedProblemId, issueId);
    if (!k) return;
    if (this.taskTitleTimers[issueId]) clearTimeout(this.taskTitleTimers[issueId]);
    this.taskTitleTimers[issueId] = setTimeout(() => {
      this.drafts.set(k, (val ?? '').toString());
    }, 600);
  }

  async createTask(problemId: string, issueId: string) {
    if (!(await this.requireOnline())) return;
    const t = (this.taskTitle[issueId] ?? '').trim();
    if (!t) return;
    this.withPid(pid => this.tasks.create(pid, problemId, issueId, { title: t }).then(() => {
      this.taskTitle[issueId] = '';
      const key = this.draftKeyTaskTitle(this.selectedProblemId, issueId);
      if (key) this.drafts.clear(key);
    }));
  }
  async renameTask(problemId: string, issueId: string, task: Task) {
    if (!(await this.requireOnline())) return;
    const t = prompt('New Task title', task.title);
    if (!t?.trim()) return;
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, task.id!, { title: t.trim() }));
  }
  async removeTask(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
    if (!confirm(`Delete Task "${t.title}"?`)) return;
    this.withPid(async pid => {
      await this.softDeleteWithUndo('task', { projectId: pid, problemId, issueId, taskId: t.id! }, t.title);
    });
  }

  // 期日・タグ編集
  async editTaskDue(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
    const cur = t.dueDate ?? '';
    const nxt = prompt('Due (YYYY-MM-DD、空で解除)', cur ?? '');
    if (nxt === null) return;
    const dueDate = (nxt.trim() === '') ? null : nxt.trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      alert('日付は YYYY-MM-DD 形式で入力してください');
      return;
    }
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, t.id!, { dueDate }));
  }
  async editTaskTags(problemId: string, issueId: string, t: Task) {
    if (!(await this.requireOnline())) return;
    const current = (t.tags ?? []).join(', ');
    const input = prompt('Tags (カンマ/スペース区切り)\n例: バグ, UI  または  バグ UI', current ?? '');
    if (input == null) return;
    const tags = input.split(/[, \s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean);
    this.withPid(pid => this.tasks.update(pid, problemId, issueId, t.id!, { tags }));
  }

  // --- Problem 作成/編集ドラフト: キー関数 ---
  private draftKeyNewProblem(): string | null {
    const pid = this.currentProject.getSync();
    if (!pid) return null;
    return `problem:new:${pid}`;
  }
  private draftKeyEditProblem(problemId: string | null): string | null {
    const pid = this.currentProject.getSync();
    if (!pid || !problemId) return null;
    return `problem:edit:${pid}:${problemId}`;
  }

  // --- Problem 作成ドラフト: 変更ハンドラ ---
  onNewProblemChange<K extends keyof typeof this.newProblem>(field: K, _val: (typeof this.newProblem)[K]) {
    const key = this.draftKeyNewProblem(); if (!key) return;
    if (this.newProblemTimers[field]) clearTimeout(this.newProblemTimers[field]);
    this.newProblemTimers[field] = setTimeout(() => {
      this.drafts.set(key, JSON.stringify(this.newProblem));
    }, 600);
  }

  // --- Problem 編集ドラフト: 変更ハンドラ ---
  onEditProblemChange<K extends EditProblemField>(field: K, _val: (typeof this.editProblem)[K]) {
    const key = this.draftKeyEditProblem(this.selectedProblemId); if (!key) return;
    if (this.editProblemTimers[field]) clearTimeout(this.editProblemTimers[field]!);
    this.editProblemTimers[field] = setTimeout(() => {
      this.drafts.set(key, JSON.stringify(this.editProblem));
    }, 600);
  }

  visibleLinks(raw: any, all: Issue[] | null | undefined): { issueId: string, type: LinkType }[] {
    if (!Array.isArray(raw) || !Array.isArray(all)) return [];
    const set = new Set(all.map(i => i.id));
    return raw
      .filter((v: any) => v && typeof v === 'object' && v.issueId && v.type)
      .filter((v: any) => set.has(String(v.issueId)))
      .map((v: any) => ({ issueId: String(v.issueId), type: v.type as LinkType }));
  }

  /** 共通：ソフトデリート → Undo 5秒 */
  private async softDeleteWithUndo(
    kind: 'problem'|'issue'|'task',
    path: { projectId: string; problemId?: string; issueId?: string; taskId?: string },
    title: string
  ){
    const uid = await firstValueFrom(this.auth.uid$);

    const patch = { softDeleted: true, deletedAt: serverTimestamp(), updatedBy: uid || '' } as any;

    if (kind === 'problem') {
      await this.problems.update(path.projectId, path.problemId!, patch);
    } else if (kind === 'issue') {
      await this.issues.update(path.projectId, path.problemId!, path.issueId!, patch);
    } else {
      await this.tasks.update(path.projectId, path.problemId!, path.issueId!, path.taskId!, patch);
    }

    const ref = this.snack.open(`「${title}」を削除しました`, '元に戻す', { duration: 5000 });
    ref.onAction().subscribe(async () => {
      const unpatch = { softDeleted: false, deletedAt: null, updatedBy: uid || '' } as any;
      if (kind === 'problem') {
        await this.problems.update(path.projectId, path.problemId!, unpatch);
      } else if (kind === 'issue') {
        await this.issues.update(path.projectId, path.problemId!, path.issueId!, unpatch);
      } else {
        await this.tasks.update(path.projectId, path.problemId!, path.issueId!, path.taskId!, unpatch);
      }
    });
  }

  // 新規Problemダイアログ用状態
  newProblemOpen = false;
  newProblem = {
    title: '',
    phenomenon: '',
    cause: '',
    solution: '',
    goal: '',
    template: 'bug' as 'bug' | 'improve'
  };

  // 編集ダイアログ用
  editProblemOpen = false;
  editProblem = {
    title: '',
    phenomenon: '',
    cause: '',
    solution: '',
    goal: ''
  };

  applyProblemTemplate(kind: 'bug' | 'improve') {
    this.newProblem.template = kind;
    if (kind === 'bug') {
      this.newProblem.phenomenon ||= '（例）保存ボタンを押してもトーストが出ず、再読み込みで初めて反映される';
      this.newProblem.goal      ||= '（例）保存操作は1秒以内にユーザーへ成功が伝わる（トースト表示／二重送信防止）';
    } else {
      this.newProblem.phenomenon ||= '（例）ダッシュボード初回表示が5秒以上かかる';
      this.newProblem.goal        ||= '（例）p50 1.5秒 / p95 3秒以下';
    }
  }

  openNewProblemDialog() {
    this.newProblemOpen = true;
    this.applyProblemTemplate(this.newProblem.template);

    // ドラフト復元
    const key = this.draftKeyNewProblem();
    if (key) {
      const rec = this.drafts.get<string>(key);
      if (rec) {
        const ok = confirm('未投稿の Problem 作成ドラフトがあります。復元しますか？');
        if (ok) {
          try { this.newProblem = { ...this.newProblem, ...JSON.parse(rec.value || '{}') }; } catch {}
        }
      }
    }
  }
  closeNewProblemDialog() {
    this.newProblemOpen = false;
    this.newProblem = { title: '', phenomenon: '', cause: '', solution: '', goal: '', template: 'bug' };
  }

  // 作成保存
  async createProblemWithDefinition() {
    if (!(await this.requireOnline())) return;

    const p = this.newProblem;
    const errs: string[] = [];
    if (!p.title.trim()) errs.push('タイトルは必須です');
    if (!p.phenomenon.trim()) errs.push('現象は必須です');
    if (!p.goal.trim()) errs.push('目標は必須です');
    const over = (s: string, n: number) => s && s.length > n;
    if (over(p.title, 200)) errs.push('タイトルは200文字以内にしてください');
    if (over(p.phenomenon, 1000)) errs.push('現象は1000文字以内にしてください');
    if (over(p.cause, 1000)) errs.push('原因は1000文字以内にしてください');
    if (over(p.solution, 1000)) errs.push('解決策は1000文字以内にしてください');
    if (over(p.goal, 500)) errs.push('目標は500文字以内にしてください');
    if (errs.length) { alert(errs.join('\n')); return; }

    const pid = this.currentProject.getSync();
    if (!pid) { alert('プロジェクト未選択'); return; }

    const uid = await firstValueFrom(this.auth.uid$);
    const payload: any = {
      title: p.title.trim(),
      template: { kind: p.template },
      problemDef: {
        phenomenon: p.phenomenon.trim(),
        goal: p.goal.trim(),
        updatedBy: uid || '',
        updatedAt: serverTimestamp(),
      }
    };
    const cause = p.cause.trim();
    const solution = p.solution.trim();
    if (cause) payload.problemDef.cause = cause;
    if (solution) payload.problemDef.solution = solution;
    
    const ref = await this.problems.create(pid, payload);
    this.selectedProblemId = (ref as any)?.id ?? null;
    this.selectedProblem$.next(this.selectedProblemId);

    const kNew = this.draftKeyNewProblem(); if (kNew) this.drafts.clear(kNew);
    this.closeNewProblemDialog();
  }

  // Firestore Timestamp → Date
  getUpdatedAtDate(p: ProblemWithDef): Date | null {
    const ts: any = p?.problemDef?.updatedAt;
    if (!ts) return null;
    try {
      if (typeof ts.toDate === 'function') return ts.toDate();
      if (ts instanceof Date) return ts;
    } catch {}
    return null;
  }

  // 編集モーダル
  openEditProblemDef(p: ProblemWithDef) {
    this.editProblemOpen = true;
    this.editProblem = {
      title: p.title ?? '',
      phenomenon: p.problemDef?.phenomenon ?? '',
      cause: p.problemDef?.cause ?? '',
      solution: p.problemDef?.solution ?? '',
      goal: p.problemDef?.goal ?? '',
    };

    // 編集ドラフト復元
    const key = this.draftKeyEditProblem(this.selectedProblemId);
    if (key) {
      const rec = this.drafts.get<string>(key);
      if (rec) {
        const ok = confirm('Problem 編集の下書きがあります。復元しますか？');
        if (ok) {
          try { this.editProblem = { ...this.editProblem, ...JSON.parse(rec.value || '{}') }; } catch {}
        }
      }
    }
  }
  closeEditProblemDialog() { this.editProblemOpen = false; }

  // 編集保存
  async saveEditedProblemDef() {
    if (!(await this.requireOnline())) return;

    const pid = this.currentProject.getSync();
    if (!pid || !this.selectedProblemId) { alert('プロジェクト/Problem未選択'); return; }

    const d = this.editProblem;
    const errs: string[] = [];
    if (!d.phenomenon.trim()) errs.push('現象は必須です');
    if (!d.goal.trim()) errs.push('目標は必須です');
    const over = (s: string, n: number) => s && s.length > n;
    if (over(d.phenomenon, 1000)) errs.push('現象は1000文字以内にしてください');
    if (over(d.cause, 1000)) errs.push('原因は1000文字以内にしてください');
    if (over(d.solution, 1000)) errs.push('解決策は1000文字以内にしてください');
    if (over(d.goal, 500)) errs.push('目標は500文字以内にしてください');
    if (errs.length) { alert(errs.join('\n')); return; }

    const uid = await firstValueFrom(this.auth.uid$);
    await this.problems.updateProblemDef(pid, this.selectedProblemId, {
      phenomenon: d.phenomenon.trim(),
      goal: d.goal.trim(),
      cause: d.cause.trim(),
      solution: d.solution.trim(),
      updatedBy: uid || '',
      updatedAt: serverTimestamp(),
    });

    const kEdit = this.draftKeyEditProblem(this.selectedProblemId); if (kEdit) this.drafts.clear(kEdit);
    this.closeEditProblemDialog();
  }

  // 破棄時のタイマー解放 & FCM購読解除
  ngOnDestroy() {
    if (this.issueTitleTimer) { clearTimeout(this.issueTitleTimer); this.issueTitleTimer = null; }
    for (const k of Object.keys(this.taskTitleTimers)) {
      if (this.taskTitleTimers[k]) { clearTimeout(this.taskTitleTimers[k]); this.taskTitleTimers[k] = null; }
    }
    Object.keys(this.newProblemTimers).forEach(k => {
      const kk = k as keyof typeof this.newProblemTimers;
      if (this.newProblemTimers[kk]) clearTimeout(this.newProblemTimers[kk]!);
    });
    Object.keys(this.editProblemTimers).forEach(k => {
      const kk = k as keyof typeof this.editProblemTimers;
      if (this.editProblemTimers[kk]) clearTimeout(this.editProblemTimers[kk]!);
    });

    this.fgSub?.unsubscribe();
  }
}




