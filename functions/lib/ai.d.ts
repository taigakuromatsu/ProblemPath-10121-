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
    /** モデルから「案の束テキスト」をもらう */
    private draftIdeas;
    /**
     * 最終API:
     * - モデルを1回叩く
     * - 必要なら追加でもう数回叩いて候補プールを増やす
     * - normalize / finalize して 5〜7件返す
     */
    suggestIssues(input: IssueSuggestInput): Promise<IssueSuggestOutput>;
}
