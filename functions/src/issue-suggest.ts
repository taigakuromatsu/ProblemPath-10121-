// ✅ v1 明示
import * as functionsV1 from 'firebase-functions/v1';
import type { Request, Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { AiClient, IssueSuggestInput } from './ai';

// ---- 入力型（後方互換も吸収）----
type HttpInput =
  | {
      lang?: 'ja' | 'en';
      projectId?: string;
      problem?: {
        title?: string;
        phenomenon?: string;
        cause?: string | null;
        solution?: string | null;
        goal?: string;
      };
      // 旧フォーマット互換
      title?: string;
      description?: string;
    }
  | undefined;

// ---- CORS ----
function setCorsHeaders(res: Response) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
}

// ---- JSON パース（Buffer/文字列対応）----
function safeParseBody(req: Request): HttpInput {
  const b: any = (req as any).body;
  if (!b) return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return {}; }
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(b)) {
    try { return JSON.parse(b.toString('utf8')); } catch { return {}; }
  }
  return b as HttpInput;
}

export const issueSuggestHttp = functionsV1
  .runWith({})
  .region('asia-northeast1')
  .https.onRequest(async (req: Request, res: Response) => {
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.status(204).send('');
      return;
    }
    setCorsHeaders(res);

    try {
      // 認証
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized: Missing or invalid authorization header' });
        return;
      }
      const token = authHeader.split('Bearer ')[1];
      const decoded = await getAuth().verifyIdToken(token);
      const uid = decoded.uid || null;
      if (!uid) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // 入力
      const raw = safeParseBody(req) || {};
      const lang = (raw.lang === 'en' ? 'en' : 'ja') as 'ja'|'en';
      const projectId = (raw.projectId || '').trim();

      // 後方互換: title/description だけ来た場合でも最低限の Problem を作る
      const fallbackProblem = {
        title: (raw as any)?.title ?? '',
        // description を分解して best-effort でフィールドに割り振り（軽いヒューリスティック）
        phenomenon: (raw as any)?.description ?? undefined,
      };

      const prob = {
        title: raw.problem?.title?.trim() || fallbackProblem.title,
        phenomenon: raw.problem?.phenomenon ?? undefined,
        cause: raw.problem?.cause ?? undefined,
        solution: raw.problem?.solution ?? undefined,
        goal: raw.problem?.goal ?? undefined,
      };

      if (!prob.title && !prob.phenomenon && !prob.goal) {
        throw new functionsV1.https.HttpsError(
          'invalid-argument',
          'Problem definition is empty. Provide at least title or phenomenon/goal.'
        );
      }

      const input: IssueSuggestInput = {
        lang,
        projectId: projectId || 'unknown',
        problem: {
          title: prob.title || '(untitled problem)',
          phenomenon: prob.phenomenon,
          cause: prob.cause,
          solution: prob.solution,
          goal: prob.goal,
        },
      };

      // AI 呼び出し
      const ai = new AiClient();
      const out = await ai.suggestIssues(input);

      res.status(200).json({ suggestions: out.suggestions.map((s) => ({ text: s })) });
    } catch (error: any) {
        console.error('[issueSuggestHttp] error', error);
        if (error instanceof functionsV1.https.HttpsError) {
          res.status(400).json({ error: error.message, code: error.code });
        } else if (error?.code === 'auth/id-token-expired' || error?.code === 'auth/argument-error') {
          res.status(401).json({ error: 'Unauthorized: Invalid token' });
        } else {
          res.status(500).json({ error: 'Internal server error', message: String(error?.message ?? error) });
        }
      }      

  
  });


