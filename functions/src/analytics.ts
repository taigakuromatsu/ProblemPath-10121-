import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

const firestore = getFirestore();

// Callable Function: refresh analytics summary for a project.
export const refreshAnalyticsSummary = onCall<
  { projectId: string },
  { ok: boolean }
>(async (request) => {
  // TODO: role check (viewerは不可)
  const { projectId } = request.data ?? {};
  if (!projectId) {
    throw new HttpsError("invalid-argument", "projectId is required");
  }

  // TODO: 最終的にはtasksなどを集計して実データを書く。Schedulerで定期実行予定。管理者/サーバ側のみ実行可能にする
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
