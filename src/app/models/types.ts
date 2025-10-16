// 共通の状態
export type Status =
  | 'not_started'   // 0%
  | 'in_progress'   // 10–60%
  | 'review_wait'   // 50%
  | 'fixing'        // 60%
  | 'done';         // 100%

// 基本フィールド（Problem/Issue/Task共通）
export interface BaseNode {
  id?: string;                    // Firestoreのdoc id
  title: string;
  description?: string;
  status?: Status;
  progress?: number;              // 0–100
  dueDate?: string;               // ISO文字列でOK（後でDate型に変更しても良い）
  priority?: 'low' | 'mid' | 'high';
  tags?: string[];
  assignees?: string[];
  order?: number;                 // 表示順
  createdAt?: any;                // Firestore Timestamp
  updatedAt?: any;                // Firestore Timestamp
}

// Problemだけが持つテンプレ（任意）
export interface Problem extends BaseNode {
  template?: {
    phenomenon?: string;
    cause?: string;
    solution?: string;
    goal?: string;
  };
}

// 先行定義（次ステップ以降で使う）
export interface Issue extends BaseNode {
  links?: string[];               // 関連課題リンク
}

export interface Task extends BaseNode {
  recurrenceRule?: {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    interval?: number;
  };
}
