// functions/src/issue-suggest.ts
import * as functionsV1 from 'firebase-functions/v1';
import type { Request, Response } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { AiClient, IssueSuggestInput } from './ai';

// CORSヘッダだけ最低限許可（今まで通りフロントのブラウザから叩けるように）
function setCorsHeaders(res: Response) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
}

// 生bodyが Buffer / string の場合にも耐える
function safeParseBody(req: Request): any {
  const b: any = (req as any).body;
  if (!b) return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return {}; }
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(b)) {
    try { return JSON.parse(b.toString('utf8')); } catch { return {}; }
  }
  return b;
}

// ★ Gen1 https.onRequest版
export const issueSuggestHttp = functionsV1
  .runWith({})
  .region('asia-northeast1')
  .https.onRequest(async (req: Request, res: Response) => {
    // プリフライト
    if (req.method === 'OPTIONS') {
      setCorsHeaders(res);
      res.status(204).send('');
      return;
    }
    setCorsHeaders(res);

    try {
      // ---- 認証チェック ----
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized: Missing or invalid authorization header' });
        return;
      }
      const idToken = authHeader.slice('Bearer '.length);
      const decoded = await getAuth().verifyIdToken(idToken);
      if (!decoded?.uid) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // ---- 入力を正規化 ----
      const raw = safeParseBody(req) || {};

      const lang: 'ja' | 'en' = raw.lang === 'en' ? 'en' : 'ja';
      const projectId: string = (raw.projectId || '').trim();

      // 互換: 古い呼び方（title/descriptionだけ）も拾う
      // 最低限 title or phenomenon/goal があればOKにする
      const fallbackProblemTitle = raw.title ?? '';
      const fallbackPhenomenonFromDesc = raw.description ?? '';

      const problem = {
        title:
          (raw.problem?.title ?? '').trim() ||
          fallbackProblemTitle,
        phenomenon: raw.problem?.phenomenon ?? fallbackPhenomenonFromDesc ?? '',
        cause:      raw.problem?.cause      ?? '',
        solution:   raw.problem?.solution   ?? '',
        goal:       raw.problem?.goal       ?? '',
      };

      if (
        !problem.title &&
        !problem.phenomenon &&
        !problem.goal
      ) {
        // ほぼ何も渡ってないケースは400扱いにして空配列返す
        res.status(400).json({ suggestions: [] });
        return;
      }

      // ---- AiClient呼び出し ----
      const ai = new AiClient();
      // AiClient.suggestIssues は IssueSuggestInput を受けるようにしておく
      const aiOut = await ai.suggestIssues({
        lang,
        projectId: projectId || 'unknown',
        problem,
      } as IssueSuggestInput);

      // aiOut は { suggestions: string[] } を想定
      // フロントは [{text:"..."}] の形を期待しているのでラップする
      const wrapped = (aiOut.suggestions || []).map(text => ({ text }));

      res.status(200).json({ suggestions: wrapped });
    } catch (err: any) {
      console.error('[issueSuggestHttp] error', err);
      // 壊さない: 何があっても suggestions は配列で返す
      res.status(200).json({ suggestions: [] });
    }
  });
