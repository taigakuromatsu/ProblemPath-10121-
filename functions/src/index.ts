import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
// import { onSchedule } from "firebase-functions/v2/scheduler";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const ping = onRequest(async (req, res) => {
  res.status(200).send("ok");
});

// 例: 将来の集計ジョブ（必要時にコメント解除・実装）
// export const nightlyAggregation = onSchedule("0 17 * * *", async (event) => {
//   // JST 02:00 相当（Cloud SchedulerはUTC基準。必要なら timeZone を指定）
//   // ここにダッシュボード集計や期限通知キュー投入などを書く
// });
