import { FieldValue, getFirestore } from "firebase-admin/firestore";
import {
  getMessaging,
  type MessagingOptions,
  type MulticastMessage,
} from "firebase-admin/messaging";

export const region = "asia-northeast1";

const firestore = () => getFirestore();
const messaging = () => getMessaging();

export interface SendSummary {
  successCount: number;
  failureCount: number;
  attemptedTokens: number;
}

export async function listProjectMemberUids(projectId: string): Promise<string[]> {
  const snapshot = await firestore().collection(`projects/${projectId}/members`).get();
  const uids = new Set<string>();
  snapshot.forEach((doc: any) => {
    const data = doc.data();
    if (typeof data?.uid === "string") {
      uids.add(data.uid);
    }
    if (doc.id) {
      uids.add(doc.id);
    }
  });
  return Array.from(uids);
}

export async function listFcmTokensForUsers(uids: string[]): Promise<string[]> {
  const tokens = new Set<string>();
  await Promise.all(
    uids.map(async (uid) => {
      const snap = await firestore().collection(`users/${uid}/fcmTokens`).get();
      snap.forEach((doc: any) => {
        const data = doc.data();
        if (typeof data?.token === "string") {
          tokens.add(data.token);
        }
        if (doc.id) {
          tokens.add(doc.id);
        }
      });
    })
  );
  return Array.from(tokens);
}

export async function sendToTokens(
  tokens: string[],
  message: Omit<MulticastMessage, "tokens">,
  options?: MessagingOptions
): Promise<SendSummary> {
  const uniqueTokens = Array.from(new Set(tokens.filter((token) => !!token)));

  if (!uniqueTokens.length) {
    return { successCount: 0, failureCount: 0, attemptedTokens: 0 };
  }

  let successCount = 0;
  let failureCount = 0;
  const chunkSize = 500;

  for (let i = 0; i < uniqueTokens.length; i += chunkSize) {
    const chunk = uniqueTokens.slice(i, i + chunkSize);
    const response = await messaging().sendEachForMulticast(
      {
        ...message,
        tokens: chunk,
      },
      options
    );

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((res: any, index: number) => {
      if (!res.success) {
        const token = chunk[index];
        console.warn(
          "[notify] Failed to send notification",
          JSON.stringify({ token, error: res.error?.code, message: res.error?.message })
        );
      }
    });
  }

  console.log(
    "[notify] Notification summary",
    JSON.stringify({ successCount, failureCount, attemptedTokens: uniqueTokens.length })
  );

  return { successCount, failureCount, attemptedTokens: uniqueTokens.length };
}

export async function wasReminderSent(
  projectId: string,
  taskId: string,
  ymd: string,
  window: "1d" | "7d"
): Promise<boolean> {
  const docRef = firestore().doc(`projects/${projectId}/auditLogs/reminders/${ymd}/tasks/${taskId}`);
  const doc = await docRef.get();
  if (!doc.exists) {
    return false;
  }
  const data = doc.data();
  const windows = data?.windows;
  return Boolean(windows && typeof windows === "object" && windows[window]);
}

export async function markReminderSent(
  projectId: string,
  taskId: string,
  ymd: string,
  window: "1d" | "7d"
): Promise<void> {
  const docRef = firestore().doc(`projects/${projectId}/auditLogs/reminders/${ymd}/tasks/${taskId}`);
  await docRef.set(
    {
      taskId,
      projectId,
      windows: {
        [window]: true,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}
