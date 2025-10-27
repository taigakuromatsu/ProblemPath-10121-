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
  dueDate?: string | null;         // ISO文字列 or null
  priority?: 'low' | 'mid' | 'high';
  tags?: string[];
  assignees?: string[];
  order?: number;                 // 表示順
  createdAt?: any;                // Firestore Timestamp
  updatedAt?: any;                // Firestore Timestamp
}

export interface ProblemDef {
  phenomenon: string;
  goal: string;
  cause?: string | null;
  solution?: string | null;
  updatedAt?: any;   // Firestore Timestamp or FieldValue
  updatedBy?: string;
}


// Problemだけが持つテンプレ（任意）
export interface Problem extends BaseNode {
  template?: {
    phenomenon?: string;
    cause?: string;
    solution?: string;
    goal?: string;
  };
  problemDef?: ProblemDef;
}

// 先行定義（次ステップ以降で使う）
export interface Issue extends BaseNode {
  links?: IssueLink[];               // 関連課題リンク
}

export interface Task extends BaseNode {
  recurrenceRule?: {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    interval?: number;
  };
  // スケジュール横断表示のための親参照
  problemId?: string;
  issueId?: string;
  projectId?: string;
}

// --- Settings scaffolding (add below your existing types) ---
export type Personality = 'analytical' | 'pragmatic' | 'creative';
export type AppLang = 'ja' | 'en';

export interface UserPrefs {
  personality: Personality;
  lang: AppLang;
  theme: 'light' | 'dark' | 'system' | 'custom';
  accentColor?: string; // 例: '#4f46e5'
}

// --- Project / Membership -------------------------------------------------

/** プロジェクト内の権限ロール */
export type ProjectRole = 'admin' | 'member' | 'viewer';

/** プロジェクトのメタ情報（projects/{projectId}/meta） */
export interface ProjectMeta {
  name: string;
  createdBy: string;   // uid
  createdAt: any;      // Firestore Timestamp
}

/** メンバー情報（projects/{projectId}/members/{uid}） */
export interface ProjectMember {
  uid: string;
  role: ProjectRole;
  joinedAt: any;       // Firestore Timestamp
}

/** ユーザーが所属するプロジェクト参照（users/{uid}/memberships/{projectId}） */
export interface UserMembership {
  projectId: string;
  role: ProjectRole;
  joinedAt: any;       // Firestore Timestamp
}

// 追加：リンクの種類
export type LinkType = 'relates' | 'duplicate' | 'blocks' | 'depends_on' | 'same_cause';

// 追加：リンクオブジェクト
export interface IssueLink {
  issueId: string;      // 相手の Issue の id
  type: LinkType;
  createdAt?: any;      // Firestore Timestamp
  createdBy?: string;   // uid
}

