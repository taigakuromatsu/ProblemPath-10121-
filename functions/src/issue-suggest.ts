// ✅ v1 を明示して読み込む
import * as functionsV1 from 'firebase-functions/v1';
import type { Request, Response } from 'express';
import { getAuth } from 'firebase-admin/auth';

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

// ---- 共通ロジック ----
async function handleIssueSuggest(data: SuggestInput, userId: string | null): Promise<SuggestOutput> {
  if (!userId) {
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
}

// ---- CORS ----
function setCorsHeaders(res: Response) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
}

// ---- Body を安全に JSON 化 ----
function safeParseBody(req: Request): SuggestInput {
  const b: any = (req as any).body;
  if (!b) return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return {}; }
  }
  // Cloud Functions 環境で Buffer の可能性もある
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(b)) {
    try { return JSON.parse(b.toString('utf8')); } catch { return {}; }
  }
  // 既にオブジェクトならそのまま
  return b as SuggestInput;
}

// ✅ v1 の region() を使用（CORS を明示的に処理する onRequest 版）
export const issueSuggestHttp = functionsV1
  .region('asia-northeast1')
  .https.onRequest(async (req: Request, res: Response) => {
    // CORS プリフライト
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.status(204).send('');
      return;
    }

    setCorsHeaders(res);

    try {
      // 認証トークンの検証
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized: Missing or invalid authorization header' });
        return;
      }

      const token = authHeader.split('Bearer ')[1];
      const auth = getAuth();
      const decodedToken = await auth.verifyIdToken(token);
      const userId = decodedToken.uid;

      // リクエストボディの解析（確実に JSON 化）
      const data: SuggestInput = safeParseBody(req);

      // 受信確認ログ（短く）
      console.log('[issueSuggestHttp] received', {
        t: (data.title || '').slice(0, 40),
        d: (data.description || '').slice(0, 40),
      });

      // ビジネスロジック
      const result = await handleIssueSuggest(data, userId);
      res.status(200).json(result);
    } catch (error: any) {
      console.error('issueSuggest error:', error);
      if (error?.code === 'auth/id-token-expired' || error?.code === 'auth/argument-error') {
        res.status(401).json({ error: 'Unauthorized: Invalid token' });
      } else if (error instanceof functionsV1.https.HttpsError) {
        res.status(400).json({ error: error.message, code: error.code });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

