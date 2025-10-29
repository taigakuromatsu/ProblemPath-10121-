
import { getApps, initializeApp } from "firebase-admin/app";
import {
  FieldValue,
  getFirestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import type { MulticastMessage, MessagingOptions } from "firebase-admin/messaging";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import {
  onDocumentCreated,
  type FirestoreEvent,
} from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  listFcmTokensForUsers,
  listProjectMemberUids,
  markReminderSent,
  region,
  sendToTokens,
  wasReminderSent,
} from "./notify";

if (!getApps().length) {
  initializeApp();
}

setGlobalOptions({ region });

export const ping = onRequest(async (_req, res) => {
  res.status(200).send("ok");
});

const firestore = getFirestore();

type CommentParams = {
  projectId: string;
  problemId: string;
  issueId?: string;
  taskId?: string;
  commentId: string;
};

type AttachmentParams = {
  projectId: string;
  problemId: string;
  issueId?: string;
  taskId?: string;
  attachmentId: string;
};

const openTaskStatuses = ["not_started", "in_progress", "review_wait", "fixing"] as const;
type ReminderWindow = "1d" | "7d";

function determineScope(params: { issueId?: string; taskId?: string }): "problem" | "issue" | "task" {
  if (params.taskId) return "task";
  if (params.issueId) return "issue";
  return "problem";
}

/** Web Push で通知クリック時に飛ばすリンクを生成（必要に応じて詳細化してください） */
function buildDeepLink(
  projectId: string,
  problemId?: string,
  issueId?: string,
  taskId?: string
): string {
  // 例: /project/:pid まで（必要なら問題/Issue/Task 詳細に拡張）
  const base = `https://kensyu10121.web.app/project/${projectId}`;
  // もし詳細導線を付けたいなら下記のように調整
  // if (taskId) return `${base}/tasks/${taskId}`;
  // if (issueId) return `${base}/issues/${issueId}`;
  // if (problemId) return `${base}/problems/${problemId}`;
  return base;
}

function withWebPushLink(
  payload: Omit<MulticastMessage, "tokens">,
  link: string
): Omit<MulticastMessage, "tokens"> & { webpush: NonNullable<MessagingOptions["webpush"]> } {
  return {
    ...payload,
    webpush: {
      ...(payload as any).webpush,
      fcmOptions: {
        ...((payload as any).webpush?.fcmOptions ?? {}),
        link,
      },
    },
  };
}

/** コメント作成時の通知（自己通知の抑止＋リンク付与） */
async function handleCommentCreated(
  event: FirestoreEvent<any, CommentParams>
) {
  const { projectId, problemId, issueId, taskId, commentId } = event.params;
  const scope = determineScope(event.params);

  // 送信者（authorId）を onCreate データから取得して自己通知を除外
  const authorId: string | undefined = event.data?.data()?.authorId;

  const allMemberUids = await listProjectMemberUids(projectId);
  const targetUids = authorId ? allMemberUids.filter(uid => uid !== authorId) : allMemberUids;
  const tokens = await listFcmTokensForUsers(targetUids);

  const notification = {
    title: "新しいコメント",
    body:
      scope === "task"
        ? "タスクにコメントが追加されました"
        : scope === "issue"
        ? "Issueにコメントが追加されました"
        : "Problemにコメントが追加されました",
  };

  const data: Record<string, string> = {
    type: "comment_created",
    projectId,
    scope,
    problemId,
    commentId,
  };
  if (issueId) data.issueId = issueId;
  if (taskId)  data.taskId  = taskId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);
  const payload = withWebPushLink({ notification, data }, link);

  console.log(
    "[notify] Comment created",
    JSON.stringify({ projectId, problemId, issueId, taskId, commentId, authorId, targetUids: targetUids.length, tokens: tokens.length })
  );

  const result = tokens.length
    ? await sendToTokens(tokens, payload)
    : { successCount: 0, failureCount: 0, attemptedTokens: 0 };

  console.log("[notify] Comment notification result", JSON.stringify(result));

  const auditRef = firestore
    .collection(`projects/${projectId}/auditLogs`)
    .doc("events")
    .collection("notifications")
    .doc();
  await auditRef.set({
    type: "comment_created",
    scope,
    projectId,
    problemId,
    issueId: issueId ?? null,
    taskId: taskId ?? null,
    commentId,
    authorId: authorId ?? null,
    sentAt: FieldValue.serverTimestamp(),
    result,
  });
  return result;
}

/** 添付作成時の通知（自己通知の抑止＋リンク付与） */
async function handleAttachmentCreated(
  event: FirestoreEvent<any, AttachmentParams>
) {
  const { projectId, problemId, issueId, taskId, attachmentId } = event.params;
  const scope = determineScope(event.params);

  // 送信者（createdBy）を onCreate データから取得して自己通知を除外
  const createdBy: string | undefined = event.data?.data()?.createdBy;

  const allMemberUids = await listProjectMemberUids(projectId);
  const targetUids = createdBy ? allMemberUids.filter(uid => uid !== createdBy) : allMemberUids;
  const tokens = await listFcmTokensForUsers(targetUids);

  const notification = {
    title: "ファイルが追加されました",
    body:
      scope === "task"
        ? "タスクにファイルが追加されました"
        : scope === "issue"
        ? "Issueにファイルが追加されました"
        : "Problemにファイルが追加されました",
  };

  const data: Record<string, string> = {
    type: "attachment_created",
    projectId,
    scope,
    problemId,
    attachmentId,
  };
  if (issueId) data.issueId = issueId;
  if (taskId)  data.taskId  = taskId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);
  const payload = withWebPushLink({ notification, data }, link);

  console.log(
    "[notify] Attachment created",
    JSON.stringify({ projectId, problemId, issueId, taskId, attachmentId, createdBy, targetUids: targetUids.length, tokens: tokens.length })
  );

  const result = tokens.length
    ? await sendToTokens(tokens, payload)
    : { successCount: 0, failureCount: 0, attemptedTokens: 0 };

  console.log("[notify] Attachment notification result", JSON.stringify(result));

  const auditRef = firestore
    .collection(`projects/${projectId}/auditLogs`)
    .doc("events")
    .collection("notifications")
    .doc();
  await auditRef.set({
    type: "attachment_created",
    scope,
    projectId,
    problemId,
    issueId: issueId ?? null,
    taskId: taskId ?? null,
    attachmentId,
    createdBy: createdBy ?? null,
    sentAt: FieldValue.serverTimestamp(),
    result,
  });
  return result;
}

function getJstToday(): Date {
  const nowUtcMs = Date.now();
  const jstMs = nowUtcMs + 9 * 60 * 60 * 1000;
  const jstDate = new Date(jstMs);
  return new Date(Date.UTC(jstDate.getUTCFullYear(), jstDate.getUTCMonth(), jstDate.getUTCDate()));
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatYmd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extractPathParams(ref: DocumentReference) {
  const segments = ref.path.split("/");
  const projectIndex = segments.indexOf("projects");
  const problemIndex = segments.indexOf("problems");
  const issueIndex = segments.indexOf("issues");
  const taskIndex = segments.indexOf("tasks");

  const projectId = projectIndex >= 0 ? segments[projectIndex + 1] : undefined;
  const problemId = problemIndex >= 0 ? segments[problemIndex + 1] : undefined;
  const issueId = issueIndex >= 0 ? segments[issueIndex + 1] : undefined;
  const taskId = taskIndex >= 0 ? segments[taskIndex + 1] : undefined;

  return { projectId, problemId, issueId, taskId };
}

async function notifyTaskReminder(
  params: {
    projectId: string;
    problemId?: string;
    issueId?: string;
    taskId: string;
  },
  dueDate: string,
  window: ReminderWindow,
  cache: Map<string, string[]>
) {
  const { projectId, problemId, issueId, taskId } = params;
  let tokens = cache.get(projectId);
  if (!tokens) {
    const memberUids = await listProjectMemberUids(projectId);
    tokens = await listFcmTokensForUsers(memberUids);
    cache.set(projectId, tokens);
  }

  if (!tokens.length) {
    console.log(
      "[notify] No tokens for reminder",
      JSON.stringify({ projectId, taskId, window, dueDate })
    );
    await markReminderSent(projectId, taskId, dueDate, window);
    return;
  }

  const data: Record<string, string> = {
    type: "task_due_soon",
    projectId,
    dueDate,
    window,
    taskId,
  };
  if (problemId) data.problemId = problemId;
  if (issueId)   data.issueId   = issueId;

  const link = buildDeepLink(projectId, problemId, issueId, taskId);
  const payload = withWebPushLink(
    {
      notification: {
        title: "期限リマインド",
        body: window === "1d" ? "タスク期限が明日に迫っています" : "タスク期限まで1週間です",
      },
      data,
    },
    link
  );

  const result = await sendToTokens(tokens, payload);

  console.log(
    "[notify] Reminder notification result",
    JSON.stringify({ projectId, taskId, window, dueDate, result })
  );

  await markReminderSent(projectId, taskId, dueDate, window);
}

// ======== Firestore triggers (自己通知抑止 & WebPushリンク 版) ========

export const commentCreatedOnProblem = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/comments/{commentId}",
  async (event: FirestoreEvent<any, CommentParams>) => {
    try {
      if (!event.data) return;
      await handleCommentCreated(event);
    } catch (e) {
      console.error("[notify] commentCreatedOnProblem error", event.params, e);
    }
  }
);

export const commentCreatedOnIssue = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/issues/{issueId}/comments/{commentId}",
  async (event: FirestoreEvent<any, CommentParams>) => {
    try {
      if (!event.data) return;
      await handleCommentCreated(event);
    } catch (e) {
      console.error("[notify] commentCreatedOnIssue error", event.params, e);
    }
  }
);

export const commentCreatedOnTask = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/issues/{issueId}/tasks/{taskId}/comments/{commentId}",
  async (event: FirestoreEvent<any, CommentParams>) => {
    try {
      if (!event.data) return;
      await handleCommentCreated(event);
    } catch (e) {
      console.error("[notify] commentCreatedOnTask error", event.params, e);
    }
  }
);

export const attachmentCreatedOnProblem = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/attachments/{attachmentId}",
  async (event: FirestoreEvent<any, AttachmentParams>) => {
    try {
      if (!event.data) return;
      await handleAttachmentCreated(event);
    } catch (e) {
      console.error("[notify] attachmentCreatedOnProblem error", event.params, e);
    }
  }
);

export const attachmentCreatedOnIssue = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/issues/{issueId}/attachments/{attachmentId}",
  async (event: FirestoreEvent<any, AttachmentParams>) => {
    try {
      if (!event.data) return;
      await handleAttachmentCreated(event);
    } catch (e) {
      console.error("[notify] attachmentCreatedOnIssue error", event.params, e);
    }
  }
);

export const attachmentCreatedOnTask = onDocumentCreated(
  "projects/{projectId}/problems/{problemId}/issues/{issueId}/tasks/{taskId}/attachments/{attachmentId}",
  async (event: FirestoreEvent<any, AttachmentParams>) => {
    try {
      if (!event.data) return;
      await handleAttachmentCreated(event);
    } catch (e) {
      console.error("[notify] attachmentCreatedOnTask error", event.params, e);
    }
  }
);

// ======== Scheduler (既存のまま + WebPushリンク付与) ========

export const taskDueReminder = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "Asia/Tokyo",
  },
  async () => {
    const today = getJstToday();
    const windows: { window: ReminderWindow; offset: number }[] = [
      { window: "1d", offset: 1 },
      { window: "7d", offset: 7 },
    ];

    const tokenCache = new Map<string, string[]>();

    for (const { window, offset } of windows) {
      const targetDate = formatYmd(addDays(today, offset));
      console.log("[notify] Checking reminders", JSON.stringify({ window, targetDate }));

      const snapshot = await firestore
        .collectionGroup("tasks")
        .where("softDeleted", "==", false)
        .where("status", "in", Array.from(openTaskStatuses))
        .where("dueDate", "==", targetDate)
        .get();

      for (const doc of snapshot.docs) {
        const taskId = doc.id;
        const { projectId, problemId, issueId } = extractPathParams(doc.ref);
        if (!projectId) {
          console.warn("[notify] Could not determine project for task", doc.ref.path);
          continue;
        }

        try {
          const alreadySent = await wasReminderSent(projectId, taskId, targetDate, window);
          if (alreadySent) {
            console.log(
              "[notify] Reminder already sent",
              JSON.stringify({ projectId, taskId, window, targetDate })
            );
            continue;
          }

          await notifyTaskReminder(
            { projectId, problemId, issueId, taskId },
            targetDate,
            window,
            tokenCache
          );
        } catch (e) {
          console.error("[notify] taskDueReminder item error", { projectId, taskId, window, targetDate }, e);
        }
      }
    }
  }
);

