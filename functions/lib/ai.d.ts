export type IssueSuggestInput = {
    lang: "ja" | "en";
    projectId: string;
    problem: {
        title: string;
        phenomenon?: string;
        cause?: string | null;
        solution?: string | null;
        goal?: string;
    };
};
export type IssueSuggestOutput = {
    suggestions: string[];
};
export declare class AiClient {
    private vertexPromise;
    constructor();
    suggestIssues(input: IssueSuggestInput): Promise<IssueSuggestOutput>;
    generateInsight(params: {
        lang: "ja" | "en";
        scope: "personal" | "project";
        completedTasks7d: number;
        avgLeadTime30dDays: number;
        lateRateThisWeekPercent: number;
        avgProgressPercent: number;
        topProblemTitle: string;
        topProblemPercent?: number;
    }): Promise<string>;
    private fallbackInsight;
}
export declare const issueSuggest: any;
export declare const generateProgressReportDraft: any;
