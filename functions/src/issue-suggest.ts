// ✅ v1 を明示して読み込む（ここがポイント）
import * as functionsV1 from 'firebase-functions/v1';
import type { CallableContext } from 'firebase-functions/v1/https';

// ---- 型定義 ----
export type SuggestInput = {
  title?: string;
  description?: string;
};

export type Suggestion = {
  text: string;
  reason?: string;
};

export type SuggestOutput = {
  suggestions: Suggestion[];
};

// ✅ v1 の region() を使用（v2とは別系統）
export const issueSuggest = functionsV1
  .region('asia-northeast1')
  .https.onCall(async (data: SuggestInput, context: CallableContext): Promise<SuggestOutput> => {
    const app = (context as any)?.app;   // App Check
    const auth = context.auth;           // Auth

    if (!app) {
      throw new functionsV1.https.HttpsError('failed-precondition', 'App Check token is missing or invalid.');
    }
    if (!auth) {
      throw new functionsV1.https.HttpsError('unauthenticated', 'Authentication required.');
    }

    const title = (data?.title ?? '').trim();
    const description = (data?.description ?? '').trim();
    if (!title && !description) {
      throw new functionsV1.https.HttpsError('invalid-argument', 'Either "title" or "description" is required.');
    }

    // ---- ダミーの提案生成ロジック ----
    const normalized = (title + ' ' + description).toLowerCase();
    const suggestions: Suggestion[] = [];

    if (normalized.includes('ui') || normalized.includes('design') || normalized.includes('レイアウト')) {
      suggestions.push({ text: 'UI改善：主要カードの情報密度を整理', reason: '重複情報の統合と階層化で可読性を向上' });
    }
    if (normalized.includes('deadline') || normalized.includes('due') || normalized.includes('期限')) {
      suggestions.push({ text: '期限アラートの段階制御（7日/3日/当日）', reason: '緊急度に応じた通知で見逃し防止' });
    }
    if (suggestions.length === 0) {
      suggestions.push(
        { text: '要件ブレイクダウン（Problem→Issue→Taskの再配分）' },
        { text: 'タグ/担当/優先度の付与を自動補助' }
      );
    }

    return { suggestions };
  });




