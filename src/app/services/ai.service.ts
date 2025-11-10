// src/app/services/ai.service.ts
import { Injectable } from '@angular/core';
import { getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

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
    title?: string;
    description?: string;
    phenomenon?: string;
    cause?: string;
    solution?: string;
    goal?: string;
  };
};

@Injectable({ providedIn: 'root' })
export class AiService {
  private auth = getAuth(getApp());
  private functions = getFunctions(getApp(), 'asia-northeast1');

  async suggestIssues(req: AiIssueSuggestRequest): Promise<string[]> {
    if (!this.auth.currentUser) throw new Error('Unauthorized');

    // 後方互換まとめ
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
        cause      ||= req.problem.cause;
        solution   ||= req.problem.solution;
        goal       ||= req.problem.goal;
      }
    }

    const infoLines: string[] = [];
    if (phenomenon) infoLines.push(`現象: ${phenomenon}`);
    if (cause)      infoLines.push(`原因: ${cause}`);
    if (solution)   infoLines.push(`対策: ${solution}`);
    if (goal)       infoLines.push(`目標: ${goal}`);
    const block = infoLines.join('\n');
    if (block) {
      description = description ? `${description}\n\n${block}` : block;
    }

    const payload = {
      lang: req.lang ?? 'ja',
      projectId: req.projectId ?? '',
      problem: {
        title,
        phenomenon: phenomenon ?? '',
        cause:      cause ?? '',
        solution:   solution ?? '',
        goal:       goal ?? '',
      },
      title,
      description,
    };

    const fn = httpsCallable<typeof payload, { suggestions: string[] }>(
      this.functions,
      'issueSuggest'
    );

    const res = await fn(payload);

    const data: any = (res as any)?.data ?? res;

    const arr: any[] = Array.isArray(data?.suggestions)
      ? data.suggestions
      : [];

    const texts = arr
      .map((item) =>
        typeof item === 'string'
          ? item.trim()
          : item && typeof item.text === 'string'
          ? item.text.trim()
          : ''
      )
      .filter((s: string) => !!s);

    return texts;
  }
}




