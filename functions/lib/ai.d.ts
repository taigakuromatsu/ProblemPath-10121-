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
    private client;
    constructor();
    suggestIssues(input: IssueSuggestInput): Promise<IssueSuggestOutput>;
}
