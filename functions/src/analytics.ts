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
  // TODO: role check (viewerは不可)
  const { projectId } = request.data ?? {};
  if (!projectId) {
    throw new HttpsError("invalid-argument", "projectId is required");
  }

  // TODO: 最終的にはtasksなどを集計して実データを書く。Schedulerで定期実行予定。管理者/サーバ側のみ実行可能にする
  const firestore = getFirestore();
  const summaryRef = firestore.doc(`projects/${projectId}/analytics/currentSummary`);
  await summaryRef.set({
    completedTasks7d: 12,
    avgLeadTime30dDays: 3.4,
    lateRateThisWeekPercent: 18,
    statusBreakdown: [
      { label: "Not Started", count: 3 },
      { label: "In Progress", count: 5 },
      { label: "Review", count: 2 },
      { label: "Done", count: 7 },
    ],
    problemProgress: [
      { title: "UI Refresh", percent: 68 },
      { title: "Backend Cleanup", percent: 42 },
      { title: "Docs Overhaul", percent: 55 },
    ],
  });

  return { ok: true };
});
