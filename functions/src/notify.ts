import { FieldValue, getFirestore } from "firebase-admin/firestore";
import {
  getMessaging,
  type MessagingOptions,
  type MulticastMessage,
} from "firebase-admin/messaging";

export const region = "asia-northeast1";

const firestore = () => getFirestore();
const messaging = () => getMessaging();

export type ReminderWindow = "1d" | "7d";

export type DueReminderMode = "none" | "1d" | "7d" | "1d7d";

export interface NotifyPrefs {
  instantComment: boolean;
  instantFile: boolean;
  dueReminderMode: DueReminderMode;
  dueReminderHour: number;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  instantComment: true,
  instantFile: true,
  dueReminderMode: "1d7d",
  dueReminderHour: 9,
};

export async function getNotifyPrefsForUsers(
  uids: string[]
): Promise<Map<string, NotifyPrefs>> {
  const db = getFirestore();
  const map = new Map<string, NotifyPrefs>();

  const unique = Array.from(new Set(uids.filter(Boolean)));

  await Promise.all(
    unique.map(async (uid) => {
      try {
        const snap = await db.doc(`users/${uid}/notifyPrefs/app`).get();
        const raw = snap.exists ? (snap.data() as Record<string, unknown>) : {};
        const prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS };

        const instantComment = raw["instantComment"];
        if (typeof instantComment === "boolean") {
          prefs.instantComment = instantComment;
        }

        const instantFile = raw["instantFile"];
        if (typeof instantFile === "boolean") {
          prefs.instantFile = instantFile;
        }

        const mode = raw["dueReminderMode"];
        if (typeof mode === "string" && ["none", "1d", "7d", "1d7d"].includes(mode)) {
          prefs.dueReminderMode = mode as DueReminderMode;
        }

        const hourRaw = raw["dueReminderHour"];
        const hour = typeof hourRaw === "number" ? hourRaw : Number(hourRaw);
        if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
          prefs.dueReminderHour = hour;
        }

        map.set(uid, prefs);
      } catch (e) {
        map.set(uid, { ...DEFAULT_NOTIFY_PREFS });
      }
    })
  );

  return map;
}

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


function getReminderDocRef(
  projectId: string,
  ymd: string,
  taskId: string
) {
  // 有効なパス:
  // projects/{projectId}/auditLogs/reminders_{ymd}/tasks/{taskId}
  return firestore().doc(
    `projects/${projectId}/auditLogs/reminders_${ymd}/tasks/${taskId}`
  );
}

export async function wasReminderSent(
  projectId: string,
  taskId: string,
  ymd: string,
  window: ReminderWindow,
  uid: string
): Promise<boolean> {
  const docRef = getReminderDocRef(projectId, ymd, taskId);
  const doc = await docRef.get();

  if (!doc.exists) return false;

  const data = doc.data();
  const windows = (data?.windows ?? {}) as Record<string, unknown>;
  const entry = windows[window];

  if (!entry) return false;
  if (entry === true) return true;

  if (typeof entry === "object" && entry !== null) {
    return Boolean((entry as Record<string, unknown>)[uid]);
  }

  return false;
}

export async function markReminderSent(
  projectId: string,
  taskId: string,
  ymd: string,
  window: ReminderWindow,
  uid: string
): Promise<void> {
  const docRef = getReminderDocRef(projectId, ymd, taskId);

  await docRef.set(
    {
      taskId,
      projectId,
      ymd,
      updatedAt: FieldValue.serverTimestamp(),
      [`windows.${window}.${uid}`]: true,
    },
    { merge: true }
  );
}
