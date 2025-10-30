// src/app/services/ai.service.ts
import { Injectable } from '@angular/core';
import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable /*, httpsCallableFromURL*/ } from 'firebase/functions';
import { getAuth } from 'firebase/auth';

export type AiIssueSuggestRequest = {
  title?: string;
  description?: string;
  projectId?: string;
  lang?: 'ja' | 'en';
  phenomenon?: string;
  cause?: string;
  solution?: string;
  goal?: string;
  problem?: string | {
    title?: string; description?: string; phenomenon?: string; cause?: string; solution?: string; goal?: string;
  };
};

@Injectable({ providedIn: 'root' })
export class AiService {
  private auth = getAuth(getApp());
  private functions = getFunctions(getApp(), 'asia-northeast1');

  async suggestIssues(req: AiIssueSuggestRequest): Promise<string[]> {
    if (!this.auth.currentUser) throw new Error('Unauthorized');

    // 後方互換の正規化
    let title = req.title ?? '';
    let description = req.description ?? '';
    let { phenomenon, cause, solution, goal } = req;

    if (req.problem) {
      if (typeof req.problem === 'string') {
        title ||= req.problem;
      } else {
        title ||= req.problem.title ?? '';
        description ||= req.problem.description ?? '';
        phenomenon ||= req.problem.phenomenon;
        cause ||= req.problem.cause;
        solution ||= req.problem.solution;
        goal ||= req.problem.goal;
      }
    }

    const lines: string[] = [];
    if (phenomenon) lines.push(`現象: ${phenomenon}`);
    if (cause)      lines.push(`原因: ${cause}`);
    if (solution)   lines.push(`対策: ${solution}`);
    if (goal)       lines.push(`目標: ${goal}`);
    const block = lines.join('\n');
    if (block) description = description ? `${description}\n\n${block}` : block;

    const payload = { title, description, projectId: req.projectId ?? '', lang: req.lang ?? 'ja' };

    // 通常の callable
    const call = httpsCallable<any, { suggestions: { text: string }[] }>(this.functions, 'issueSuggest');

    // ※もし切り分けたければ直URLでも試せます（コメント解除）
    // const call = httpsCallableFromURL<any, { suggestions: { text: string }[] }>(
    //   this.functions,
    //   'https://asia-northeast1-kensyu10121.cloudfunctions.net/issueSuggest'
    // );

    const res = await call(payload);
    const suggestions = Array.isArray(res?.data?.suggestions) ? res.data.suggestions : [];
    return suggestions.map(s => s?.text).filter(Boolean);
  }
}



