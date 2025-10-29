import { type MessagingOptions, type MulticastMessage } from "firebase-admin/messaging";
export declare const region = "asia-northeast1";
export interface SendSummary {
    successCount: number;
    failureCount: number;
    attemptedTokens: number;
}
export declare function listProjectMemberUids(projectId: string): Promise<string[]>;
export declare function listFcmTokensForUsers(uids: string[]): Promise<string[]>;
export declare function sendToTokens(tokens: string[], message: Omit<MulticastMessage, "tokens">, options?: MessagingOptions): Promise<SendSummary>;
export declare function wasReminderSent(projectId: string, taskId: string, ymd: string, window: "1d" | "7d"): Promise<boolean>;
export declare function markReminderSent(projectId: string, taskId: string, ymd: string, window: "1d" | "7d"): Promise<void>;
