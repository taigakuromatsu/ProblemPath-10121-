# ProblemPath 開発メモ

## 通知機能（PR1 実装分）

### FCM トークン保存の確認
1. `npm start` でフロントを起動し、ブラウザでホーム画面 (`/home`) を開きます。
2. Google サインイン後、「通知を有効化」ボタンを押して権限を許可します。
3. Firestore コンソールまたは `firebase emulators:start --only firestore` を使い、`users/{uid}/fcmTokens/{token}` ドキュメントが作成されていることを確認します。
   - フィールドに `createdAt` / `lastSeenAt` / `platform` / `userAgent` が含まれること。
   - 同じ端末で再読込しても同じ docId（= トークン）が維持され、`lastSeenAt` が更新されること。

### コメント / ファイル追加での自動通知
1. Functions をビルドしてデプロイします。
   ```bash
   npm --prefix functions run build
   firebase deploy --only functions:notifyOnTaskComment,functions:notifyOnTaskFile,functions:notifyOnTaskAttachment
   ```
   エミュレータで検証する場合は `npm --prefix functions run shell` から `notifyOnTaskComment` 等を手動実行できます。
2. プロジェクトメンバー A / B の 2 アカウントを用意し、A 側でタスクにコメントまたは添付ファイルを追加します。
3. 数秒後に B 側へ FCM 通知が届き、タイトルが「コメントが追加されました」または「ファイルが追加されました」になっていることを確認します。
4. Firebase コンソールの Cloud Functions ログで、送信件数 (`success`/`failure`) と不要トークン削除ログが出力されていることを確認します。
   - 無効トークンを試したい場合は、`users/{uid}/fcmTokens` に存在しない / 期限切れトークンを手動で追加し、通知を発火させて削除ログが出るか確認します。

### 補足
- デプロイ後にトークンの削除が発生した場合は `users/{uid}/fcmTokens/*` から自動で削除されます。
- 通知 payload には `deepLink=/board?pid=...&iid=...&tid=...` が含まれるため、PR2 での遷移実装に利用してください。
