// src/app/models/attachments.ts
export type AttachmentTarget =
  | { kind:'problem'; projectId:string; problemId:string; }
  | { kind:'issue';   projectId:string; problemId:string; issueId:string; }
  | { kind:'task';    projectId:string; problemId:string; issueId:string; taskId:string; };

/** Firestore に保存する添付メタ情報 */
export interface AttachmentDoc {
  id?: string;          // rxfire の idField で入る
  name: string;         // 元ファイル名
  contentType: string;  // 例: 'image/png' | 'application/pdf'
  size: number;         // バイト
  storagePath: string;  // Storage のパス（/projects/... 形式）
  downloadURL?: string; // 表示最適化用（取得後に更新）
  sha256?: string;      // 任意: 重複検出・キャッシュ用
  createdAt: any;       // serverTimestamp
  createdBy: string;    // uid
  updatedAt?: any;      // serverTimestamp
  note?: string|null;       // キャプション等（将来用）
  tags?: string[];          // タグ（将来用）
  softDeleted?: boolean;    // 既存パターンに合わせる
}
