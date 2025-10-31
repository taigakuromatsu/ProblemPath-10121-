
// functions/src/ai.ts

// ==== Vertex defaults ====
// Firebase Functions 側で使う Vertex AI 呼び出しロジック。
// ブラウザ専用の HttpClient / getAuth とかは絶対に使わないこと。

const PROJECT =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.PROJECT_ID ||
  "kensyu10121";

const LOCATION = "asia-northeast1";
const MODEL    = "gemini-2.5-pro";

// ---- 型 ----
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

// 要件
const TARGET_MIN = 5; // 最低ほしい件数
const TARGET_MAX = 7; // 返す上限
const MAX_RETRY  = 2; // draftIdeas() の追加呼び出し回数 (不足時)

// ------------------------------
// ユーティリティ / 正規化系
// ------------------------------
function squeezeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 箇条書きマーカー・先頭番号などを削る */
function stripListMarker(line: string): string {
  return line
    .replace(/^[\s\-*●・•]+/, "")         // 先頭の箇条書き記号
    .replace(/^\s*\d+[\.\)]\s*/, "")      // "1. " / "2) " など
    .trim();
}

/** 行末の句読点やカッコ閉じだけ落とす（文章の尻尾をチップにしやすくする） */
function stripEdgePunct(line: string): string {
  return line
    .replace(/[\s"「『（(【]+$/, "")
    .replace(/["」』）)】\s]+$/, "")
    .replace(/[。．､、，,.…]+$/, "")
    .trim();
}

/** 1行の案を「Issueタイトルっぽい短い命令形」に整える */
function sanitizeTitle(raw: string): string {
  let t = raw ?? "";
  t = t.replace(/\r/g, " ").replace(/\n/g, " ");
  t = squeezeSpaces(t);
  t = stripListMarker(t);
  t = stripEdgePunct(t);

  // JSON臭・制御文字ざっくり排除
  if (/[{}\[\]`]/.test(t)) return "";

  // 長すぎる文章は80文字付近で切る（単語途中は切らない）
  if (t.length > 80) {
    const cut = t.slice(0, 80);
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 0) t = cut.slice(0, lastSpace).trim();
    else t = cut.trim();
  }

  // 記号だけは却下
  if (!/[A-Za-z0-9\u3040-\u30FF\u4E00-\u9FFF]/.test(t)) return "";

  return t.trim();
}

/** モデルの生テキストを候補群にしてクリーンアップ */
function normalizeDraftLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of lines) {
    const title = sanitizeTitle(raw);
    if (!title) continue;

    // 短すぎ・長すぎは落とす
    if (title.length < 6) continue;
    if (title.length > 60) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    result.push(title);
    if (result.length >= 20) break; // プールとして20個あれば十分
  }

  return result;
}

/** モデルの返答テキストを1行ずつばらして正規化 */
function normalizeDraftText(draftText: string): string[] {
  const rawLines = draftText
    .split(/\r?\n+/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  return normalizeDraftLines(rawLines);
}

/** 複数プールをマージし、重複除去して 5〜7件にまとめる */
function finalizeSuggestions(pools: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const pool of pools) {
    for (const t of pool) {
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(t);
      if (merged.length >= TARGET_MAX) break;
    }
    if (merged.length >= TARGET_MAX) break;
  }

  return merged.slice(0, TARGET_MAX);
}

// ------------------------------
// プロンプト生成
// ------------------------------
function buildDraftPrompt(input: IssueSuggestInput): { system: string; user: string } {
  const isJa = input.lang === "ja";

  if (isJa) {
    const system = [
      "あなたはプロダクトマネージャーです。",
      "以下の課題を解決するための、具体的な作業タスク案をできるだけ多く提案してください。",
      "・各タスク案は1行だけの短い命令形で書いてください（〜する、〜を実装する など）",
      "・似た案は避けてください",
      "・そのままissueタイトルに使える粒度で、誰が見ても行動がわかる表現にしてください",
      "・形式はテキストのみでOKです。JSONで返さないでください。",
      "・最低8案は出してください。",
    ].join("\n");

    const userLines = [
      `プロジェクトID: ${input.projectId}`,
      `課題タイトル: ${input.problem.title || ""}`,
      input.problem.phenomenon ? `現象: ${input.problem.phenomenon}` : "",
      input.problem.cause ? `原因: ${input.problem.cause}` : "",
      input.problem.solution ? `現在の想定解決策: ${input.problem.solution}` : "",
      input.problem.goal ? `目標/ゴール: ${input.problem.goal}` : "",
      "",
      "では、箇条書きのように1行ずつ案を列挙してください。"
    ]
      .filter(Boolean)
      .join("\n");

    return { system, user: userLines };
  } else {
    const system = [
      "You are a product manager.",
      "Generate as many concrete, actionable task ideas as possible to address the problem below.",
      "- Each idea should be one short imperative/title line (e.g. 'Add long-press drag start').",
      "- Avoid near-duplicates.",
      "- Make each line usable directly as an issue title.",
      "- Plain text only. Do NOT respond in JSON.",
      "- Output at least 8 ideas.",
    ].join("\n");

    const userLines = [
      `Project ID: ${input.projectId}`,
      `Problem Title: ${input.problem.title || ""}`,
      input.problem.phenomenon ? `Observed Behavior: ${input.problem.phenomenon}` : "",
      input.problem.cause ? `Likely Cause: ${input.problem.cause}` : "",
      input.problem.solution ? `Proposed Direction: ${input.problem.solution}` : "",
      input.problem.goal ? `Goal / Target: ${input.problem.goal}` : "",
      "",
      "Now list actionable issue/task titles, one per line."
    ]
      .filter(Boolean)
      .join("\n");

    return { system, user: userLines };
  }
}

// ------------------------------
// Vertex 呼び出しクライアント
// ------------------------------
export class AiClient {
  private vertexPromise: Promise<any>;

  constructor() {
    const project = PROJECT;
    const location = LOCATION;
    this.vertexPromise = (async () => {
      const { VertexAI } = await import("@google-cloud/vertexai");
      return new VertexAI({ project, location });
    })();
  }

  /** モデルから「案の束テキスト」をもらう */
  private async draftIdeas(input: IssueSuggestInput): Promise<string> {
    const vertex = await this.vertexPromise;
    const { system, user } = buildDraftPrompt(input);

    const model = vertex.getGenerativeModel({
      model: MODEL,
      systemInstruction: system,
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        maxOutputTokens: 512,
        candidateCount: 1,
      },
    });

    const resp = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: user }] }
      ] as any,
    });

    const cands = resp?.response?.candidates ?? [];
    const chunks: string[] = [];
    for (const c of cands) {
      const parts = c?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p?.text === "string") {
          chunks.push(p.text);
        }
      }
    }
    return chunks.join("\n");
  }

  /**
   * 最終API:
   * - モデルを1回叩く
   * - 必要なら追加でもう数回叩いて候補プールを増やす
   * - normalize / finalize して 5〜7件返す
   */
  async suggestIssues(input: IssueSuggestInput): Promise<IssueSuggestOutput> {
    const pools: string[][] = [];

    // 1回目
    const firstText = await this.draftIdeas(input);
    const firstPool = normalizeDraftText(firstText);
    pools.push(firstPool);

    // 少なすぎたら追加で叩く（最大 MAX_RETRY 回）
    for (let i = 0; i < MAX_RETRY; i++) {
      const currentCount = finalizeSuggestions(pools).length;
      if (currentCount >= TARGET_MIN) break;
      const moreText = await this.draftIdeas(input);
      const morePool = normalizeDraftText(moreText);
      pools.push(morePool);
    }

    const finalList = finalizeSuggestions(pools);

    return { suggestions: finalList };
  }
}
