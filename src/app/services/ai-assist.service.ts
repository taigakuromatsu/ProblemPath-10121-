import { Injectable, inject } from '@angular/core';
import { Functions, httpsCallable } from '@angular/fire/functions';

export interface IssueSuggestion {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface SuggestIssuesPayload {
  problemTitle: string;
  problemTemplate: {
    phenomenon?: string;
    cause?: string;
    goal?: string;
    constraints?: string;
    stakeholders?: string;
    metrics?: string;
    solution?: string;
  };
  locale?: 'ja' | 'en';
}

@Injectable({ providedIn: 'root' })
export class AiAssistService {
  private readonly functions = inject(Functions);

  async suggestIssues(payload: SuggestIssuesPayload): Promise<IssueSuggestion[]> {
    const callable = httpsCallable(this.functions, 'suggestIssues');
    const response = await callable(payload);
    const data = (response?.data as { suggestions?: any[] | undefined }) ?? {};
    if (!Array.isArray(data.suggestions)) {
      return [];
    }
    return data.suggestions
      .map((item): IssueSuggestion | null => {
        if (!item) return null;
        const title = typeof item.title === 'string' ? item.title : '';
        if (!title) return null;
        const description = typeof item.description === 'string' ? item.description : '';
        const acceptanceCriteria = Array.isArray(item.acceptanceCriteria)
          ? item.acceptanceCriteria
              .filter((ac: unknown): ac is string => typeof ac === 'string' && !!ac.trim())
          : [];
        return { title, description, acceptanceCriteria };
      })
      .filter((item): item is IssueSuggestion => item !== null);
  }
}
