// src/app/services/ai.service.ts
import { Injectable } from '@angular/core';
import { getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { HttpClient, HttpHeaders } from '@angular/common/http';

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

// Gen1側レスポンスの型
type IssueSuggestHttpResponse = {
  suggestions: Array<{ text: string }>;
};

@Injectable({ providedIn: 'root' })
export class AiService {
  private auth = getAuth(getApp());
  private functionsUrl =
    'https://asia-northeast1-kensyu10121.cloudfunctions.net/issueSuggestHttp';

  constructor(private http: HttpClient) {}

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
      title,
      description,
      problem: {
        title,
        phenomenon: phenomenon ?? '',
        cause:      cause ?? '',
        solution:   solution ?? '',
        goal:       goal ?? '',
      },
    };

    // Firebase ID token を Authorization に付与
    const token = await this.auth.currentUser?.getIdToken();
    if (!token) throw new Error('Unauthorized: No token available');

    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });

    // Gen1のHTTP関数を叩く
    const res = await this.http
      .post<IssueSuggestHttpResponse>(this.functionsUrl, payload, { headers })
      .toPromise();

    if (!res || !Array.isArray(res.suggestions)) {
      return [];
    }

    // [{text:"..."}] → ["..."]
    return res.suggestions
      .map(item => (item && item.text) ? item.text.trim() : '')
      .filter(s => !!s);
  }
}




