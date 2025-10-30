import { GoogleGenerativeAI } from "@google/generative-ai";

export async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const generativeModel = genAI.getGenerativeModel({
    model,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.3,
    },
  });

  const result = await generativeModel.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  });

  return result.response?.text() ?? "";
}
