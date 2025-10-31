import { getFirestore } from "firebase-admin/firestore";
// @ts-ignore - firebase-functions/v2/httpsの型定義の問題を回避
import { onCall, HttpsError } from "firebase-functions/v2/https";
// @ts-ignore
import type { CallableRequest } from "firebase-functions/v2/https";

// Callable Function: refresh analytics summary for a project.
export const refreshAnalyticsSummary = onCall<
  { projectId: string },
  { ok: boolean }
>(async (request: CallableRequest<{ projectId: string }>) => {
  // TODO: Security Rules will restrict writes to analytics/currentSummary
  // so that only backend Functions can write here. Clients will read only.
  // TODO: role check (viewerは不可)
  const { projectId } = request.data ?? {};
  if (!projectId) {
    throw new HttpsError("invalid-argument", "projectId is required");
  }

  const firestore = getFirestore();
  // TODO: 各taskドキュメントに projectId フィールド前提。ただし存在しない場合は今後付与予定
  const tasksSnapshot = await firestore
    .collectionGroup("tasks")
    .where("projectId", "==", projectId)
    .get();

  const knownStatuses: Array<{ value: string; label: string }> = [
    { value: "not_started", label: "未着手" },
    { value: "in_progress", label: "対応中" },
    { value: "review", label: "レビュー中" },
    { value: "done", label: "完了" },
  ];
  const statusCounts: Record<string, number> = {};
  let completedTasksCount = 0;

  tasksSnapshot.forEach((doc) => {
    const data = doc.data() ?? {};
    const status = (data.status as string) ?? "not_started";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status === "done") {
      completedTasksCount += 1;
    }
  });

  const statusBreakdown: Array<{ label: string; count: number }> = knownStatuses.map(
    ({ value, label }) => ({ label, count: statusCounts[value] ?? 0 })
  );

  Object.entries(statusCounts).forEach(([status, count]) => {
    if (!knownStatuses.some((known) => known.value === status)) {
      statusBreakdown.push({ label: status, count });
    }
  });

  const problemsSnapshot = await firestore
    .collection(`projects/${projectId}/problems`)
    .get();

  const problemProgress = await Promise.all(
    problemsSnapshot.docs.map(async (problemDoc) => {
      const tasksForProblem = await problemDoc.ref.collection("tasks").get();
      const totalTasks = tasksForProblem.size;
      const doneTasks = tasksForProblem.docs.reduce((count, taskDoc) => {
        const status = taskDoc.get("status");
        return status === "done" ? count + 1 : count;
      }, 0);
      const percent =
        totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100);
      const title = (problemDoc.get("title") as string) ?? "";

      return { title, percent };
    })
  );

  const summaryRef = firestore.doc(`projects/${projectId}/analytics/currentSummary`);
  await summaryRef.set(
    {
      completedTasks7d: completedTasksCount,
      // TODO: will compute using startAt/doneAt timestamps and dueDate in a later step
      avgLeadTime30dDays: 3.6,
      // TODO: will compute using startAt/doneAt timestamps and dueDate in a later step
      lateRateThisWeekPercent: 18.2,
      statusBreakdown,
      problemProgress,
    },
    { merge: true }
  );

  return { ok: true };
});
