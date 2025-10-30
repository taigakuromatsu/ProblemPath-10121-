import OpenAI from "openai";

export async function callOpenAI(
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "You are an assistant that outputs pure JSON only." },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
  });

  return response.choices[0]?.message?.content ?? "";
}
