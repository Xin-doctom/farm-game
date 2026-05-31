/**
 * DeepSeek API 客户端 (OpenAI 兼容接口)
 */
const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(
  messages: ChatMessage[],
  options?: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  }
): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options?.model ?? "deepseek-chat",
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 2000,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }

  const json = await res.json();
  return json.choices[0].message.content;
}

/**
 * 带系统提示的快捷对话
 */
export async function chatWithSystem(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  return chat([
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]);
}
