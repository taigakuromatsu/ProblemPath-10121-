// functions/src/ai.ts
// Vertex AI (Gemini) 版: JSON 優先 + 行分割フェイルセーフ
// @ts-ignore - firebase-functions/v2/httpsの型定義の問題を回避
import { onCall, HttpsError } from "firebase-functions/v2/https";
// @ts-ignore
import type { CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";

// ==== Vertex defaults（環境変数が無ければこれを使う）====
const PROJECT =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.PROJECT_ID ||
  "kensyu10121";

const LOCATION = process.env.VERTEX_LOCATION || "asia-northeast1";
const MODEL    = process.env.VERTEX_MODEL    || "gemini-2.5-flash";

// ====== 型 ======
export type IssueSuggestInput = {
  lang: "ja" | "en";
  projectId: string;
  problem: {
    title: string;
    phenomenon?: string;
    cause?: string | null;
    solution?: string | null;
    goal?: string;
  };
};

export type IssueSuggestOutput = { suggestions: string[] };

// ====== System prompts ======
const SYSTEM_EN =
  `You generate concise, actionable issue titles for a Kanban/issue tracker. ` +
  `Reply ONLY as JSON: {"suggestions": string[]}. 5-7 items, 8–36 chars, imperative, no duplicates.`;

const SYSTEM_JA =
  `あなたは課題管理ツール向けに短く実行可能なイシュータイトルを作成します。` +
  `必ず JSON でのみ返答: {"suggestions": string[]}。5〜7件、8〜36文字、命令形、重複なし。`;

// ====== helper ======
function cleanLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((x) => x.replace(/^[-*●・\d\.\)\]]+\s*/, "").trim())
    .filter(Boolean);
}

function buildPrompt(input: IssueSuggestInput): string {
  const preferLang = input.lang === "ja" ? "Japanese" : "English";
  return [
    `Project ID: ${input.projectId}`,
    `Problem Title: ${input.problem.title}`,
    input.problem.phenomenon ? `Phenomenon: ${input.problem.phenomenon}` : "",
    input.problem.cause ? `Cause: ${input.problem.cause}` : "",
    input.problem.solution ? `Solution: ${input.problem.solution}` : "",
    input.problem.goal ? `Goal/KPI: ${input.problem.goal}` : "",
    "",
    `Return ${preferLang} issue titles only.`,
    `Rules:`,
    `- 8–36 characters`,
    `- Start with a verb`,
    `- Specific & scannable`,
    `- No numbering, no markdown`,
    `- Avoid duplicates`,
    `- Provide 5 to 7 lines`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ====== Vertex クライアント ======
export class AiClient {
  private vertexPromise: Promise<any>;

  constructor() {
    const project = PROJECT;
    const location = LOCATION;
    // 遅延 import で他関数への影響を最小化
    this.vertexPromise = (async () => {
      const { VertexAI } = await import("@google-cloud/vertexai");
      return new VertexAI({ project, location });
    })();
  }

  async suggestIssues(input: IssueSuggestInput): Promise<IssueSuggestOutput> {
    const vertex = await this.vertexPromise;

    const sys = input.lang === "ja" ? SYSTEM_JA : SYSTEM_EN;
    const prompt = buildPrompt(input);

    const model = vertex.getGenerativeModel({
      model: MODEL,
      systemInstruction: sys,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.3,
      },
    });

    try {
      // Vertex SDK の generateContent は { contents } 形式
      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }] as any,
      });

      // 応答本文（JSON 期待）
      const parts = (resp as any)?.response?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p: any) => (p?.text ?? "").trim()).filter(Boolean).join("\n");

        // 追加: parts が複数ならそれをそのまま候補化（JSON不達時の強化）
        if (Array.isArray(parts) && parts.length > 1) {
        const fromParts = parts
            .map((p: any) => (p?.text ?? "").trim())
            .filter(Boolean);
        if (fromParts.length >= 3) {
            return { suggestions: fromParts.slice(0, 7) };
        }
        }

      // 1) JSON 優先
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed?.suggestions)) {
            const arr = parsed.suggestions as unknown[];
            const normalized = arr
                .map(x => {
                if (typeof x === "string") return x.trim();
                if (x && typeof x === "object" && typeof (x as any).text === "string") {
                    return String((x as any).text).trim();
                }
                return "";
                })
                .filter(Boolean);
            if (normalized.length) {
                return { suggestions: normalized.slice(0, 7) };
            }
            }
        } catch {
            /* JSON でなければ行分割へ */
        }
  

      const suggestions = cleanLines(text).slice(0, 7);
      return { suggestions };
    } catch (e: any) {
      console.error("[VertexAI] call failed", {
        message: e?.message,
        model: MODEL,
        location: LOCATION,
        details: e,
      });
      throw new Error(`Vertex request failed: ${String(e?.message ?? e)}`);
    }
  }
}

export const generateProgressReportDraft = onCall<
  { projectId: string },
  {
    title: string;
    body: string;
    metrics: { completedTasks: number; avgProgressPercent: number; notes: string };
  }
>(async (request: CallableRequest<{ projectId: string }>) => {
  // TODO: viewerロールは拒否したい（admin/memberだけ許可する）
  const { projectId } = request.data ?? {};
  if (!projectId) {
    throw new HttpsError("invalid-argument", "projectId is required");
  }

  const firestore = getFirestore();
  const summaryRef = firestore.doc(`projects/${projectId}/analytics/currentSummary`);
  const summarySnap = await summaryRef.get();

  if (!summarySnap.exists) {
    throw new HttpsError("not-found", "Analytics summary not found");
  }

  const summary = summarySnap.data() ?? {};
  const completedTasks7d = typeof summary.completedTasks7d === "number" ? summary.completedTasks7d : 0;
  const avgLeadTime30dDays = typeof summary.avgLeadTime30dDays === "number" ? summary.avgLeadTime30dDays : 0;
  const lateRateThisWeekPercent = typeof summary.lateRateThisWeekPercent === "number" ? summary.lateRateThisWeekPercent : 0;
  const problemProgress = Array.isArray(summary.problemProgress) ? summary.problemProgress : [];

  const normalizedProgress = problemProgress
    .map((item: any) => ({
      title: typeof item?.title === "string" ? item.title : "",
      percent: typeof item?.percent === "number" ? item.percent : 0,
    }))
    .filter((item: { title: string; percent: number }) => item.title || item.percent);

  const avgProgressPercent = normalizedProgress.length
    ? Math.round(
        normalizedProgress.reduce((total: number, current: { title: string; percent: number }) => total + current.percent, 0) /
          normalizedProgress.length,
      )
    : 0;

  const topProblem = normalizedProgress[0];
  const topProblemTitle = topProblem?.title || "重点課題";
  const topProblemPercent = topProblem?.percent ?? 0;

  const title = "Weekly Progress Summary";
  const bodyParts = [
    `完了タスクは ${completedTasks7d} 件。`,
    `平均対応日数は ${avgLeadTime30dDays} 日程度。`,
    `遅延率は ${lateRateThisWeekPercent}% に留まっています。`,
    `特に ${topProblemTitle} は進捗 ${topProblemPercent}% まで進み、引き続き優先テーマです。`,
  ];

  const notes = `優先テーマは ${topProblemTitle}`;

  // TODO: 最終的にはGeminiを使って自然な文章にする
  return {
    title,
    body: bodyParts.join(" "),
    metrics: {
      completedTasks: completedTasks7d,
      avgProgressPercent,
      notes,
    },
  };
});

  

  
