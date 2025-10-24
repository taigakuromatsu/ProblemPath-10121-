import * as admin from 'firebase-admin';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall } from 'firebase-functions/v2/https';

admin.initializeApp();

// すべての関数のデフォルト地域を設定
setGlobalOptions({ region: 'asia-northeast1' });

/** 監査ログを書き込む（追記のみ） */
async function writeAudit(
  projectId: string,
  entity: 'problem' | 'issue' | 'task',
  entityId: string,
  action: 'create' | 'update' | 'delete',
  by?: string | null
) {
  const db = admin.firestore();
  const col = db.collection(`projects/${projectId}/auditLogs`);
  await col.add({
    entity,
    entityId,
    action,
    by: by ?? null,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** 差分から action と by を推定 */
function actionAndBy(
  before: FirebaseFirestore.DocumentData | null,
  after: FirebaseFirestore.DocumentData | null
) {
  let action: 'create' | 'update' | 'delete';
  if (!before && after) action = 'create';
  else if (before && !after) action = 'delete';
  else action = 'update';
  const by =
    (after?.updatedBy ??
      before?.updatedBy ??
      after?.createdBy ??
      before?.createdBy) ?? null;
  return { action, by };
}

/** Problems onWrite -> auditLogs 追記 */
export const auditProblemsOnWrite = onDocumentWritten(
  'projects/{projectId}/problems/{problemId}',
  async (event) => {
    const { projectId, problemId } = event.params as {
      projectId: string;
      problemId: string;
    };
    const before = event.data?.before.exists ? event.data.before.data()! : null;
    const after = event.data?.after.exists ? event.data.after.data()! : null;
    const { action, by } = actionAndBy(before, after);
    await writeAudit(projectId, 'problem', problemId, action, by);
  }
);

/** Issues onWrite -> auditLogs 追記 */
export const auditIssuesOnWrite = onDocumentWritten(
  'projects/{projectId}/problems/{problemId}/issues/{issueId}',
  async (event) => {
    const { projectId, issueId } = event.params as {
      projectId: string;
      issueId: string;
    };
    const before = event.data?.before.exists ? event.data.before.data()! : null;
    const after = event.data?.after.exists ? event.data.after.data()! : null;
    const { action, by } = actionAndBy(before, after);
    await writeAudit(projectId, 'issue', issueId, action, by);
  }
);

/** Tasks onWrite -> auditLogs 追記 */
export const auditTasksOnWrite = onDocumentWritten(
  'projects/{projectId}/problems/{problemId}/issues/{issueId}/tasks/{taskId}',
  async (event) => {
    const { projectId, taskId } = event.params as {
      projectId: string;
      taskId: string;
    };
    const before = event.data?.before.exists ? event.data.before.data()! : null;
    const after = event.data?.after.exists ? event.data.after.data()! : null;
    const { action, by } = actionAndBy(before, after);
    await writeAudit(projectId, 'task', taskId, action, by);
  }
);

/**
 * ソフトデリート検出の DRY-RUN パージ
 * - 実削除はしないでログ出力のみ（既存データへ無影響）
 * - 7日超経過した softDeleted ドキュメントを collectionGroup で拾う
 */
export const purgeSoftDeletedDryRun = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Asia/Tokyo' },
  async (event) => {
    const db = admin.firestore();
    const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    );

    const collect = async (group: 'problems' | 'issues' | 'tasks') => {
      const snap = await db
        .collectionGroup(group)
        .where('softDeleted', '==', true)
        .where('deletedAt', '<=', cutoff)
        .get();
      console.log(`[DRY-RUN] ${group} purge candidates: ${snap.size}`);
      snap.docs.slice(0, 100).forEach((d) => {
        console.log(`[DRY-RUN] ${group} → ${d.ref.path}`);
      });
      if (snap.size > 100) {
        console.log(`[DRY-RUN] ${group} → ...and ${snap.size - 100} more`);
      }
    };

    await Promise.all(['problems', 'issues', 'tasks'].map((g) => collect(g as any)));
    return ;
  }
);

/** （任意）将来用：サーバエクスポートの骨子 */
export const exportProjectCallable = onCall(async (request) => {
  const projectId = String(request.data?.projectId ?? '');
  if (!projectId) {
    // v2 の HttpsError は throw しなくても return でOKだが、ここは厳密に
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { HttpsError } = require('firebase-functions/v2/https');
    throw new HttpsError('invalid-argument', 'projectId is required');
  }
  return { ok: true, projectId };
});
