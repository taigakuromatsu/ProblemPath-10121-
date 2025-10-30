import * as functionsV1 from 'firebase-functions/v1';
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
export declare const issueSuggestHttp: functionsV1.HttpsFunction;
