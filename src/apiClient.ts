import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface ApiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface ChatChoice {
  message: ChatMessage;
}

interface ChatResponse {
  choices: ChatChoice[];
}

export class ApiClient {
  constructor(private cfg: ApiConfig) {}

  async chat(
    messages: ChatMessage[],
    tools?: any[],
    signal?: AbortSignal,
    onDelta?: (token: string) => void
  ): Promise<ChatMessage> {
    const url = this.buildUrl();
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      stream: true,
      ...(tools && tools.length ? { tools } : {}),
    });

    return new Promise<ChatMessage>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"));
        return;
      }

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
        },
        (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            let errorData = "";
            res.on("data", (chunk) => (errorData += chunk));
            res.on("end", () => {
              reject(new Error(`API error ${res.statusCode}: ${errorData}`));
            });
            return;
          }

          let buffer = "";
          const finalMessage: ChatMessage = { role: "assistant", content: "" };

          res.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete trailing line

            for (let line of lines) {
              line = line.trim();
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                try {
                  const parsed = JSON.parse(line.slice(6));
                  const delta = parsed.choices?.[0]?.delta;
                  
                  if (!delta) continue;

                  // Stream and accumulate content
                  if (delta.content) {
                    finalMessage.content = (finalMessage.content || "") + delta.content;
                    if (onDelta) onDelta(delta.content);
                  }

                  // Accumulate tool calls 
                  if (delta.tool_calls) {
                    if (!finalMessage.tool_calls) finalMessage.tool_calls = [];
                    
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index;
                      if (!finalMessage.tool_calls[idx]) {
                        finalMessage.tool_calls[idx] = {
                          id: tc.id,
                          type: tc.type || "function",
                          function: { 
                            name: tc.function?.name || "", 
                            arguments: tc.function?.arguments || "" 
                          }
                        };
                      } else {
                        if (tc.function?.arguments) {
                          finalMessage.tool_calls[idx].function.arguments += tc.function.arguments;
                        }
                      }
                    }
                  }
                } catch (e) {
                  // Ignore partial/malformed JSON mid-stream
                }
              }
            }
          });

          res.on("end", () => {
            // Remove nulls if indices were skipped
            if (finalMessage.tool_calls) {
              finalMessage.tool_calls = finalMessage.tool_calls.filter(Boolean);
            }
            resolve(finalMessage);
          });
        }
      );

      req.on("error", (err: any) => {
        if (signal?.aborted) {
          reject(new Error("Aborted"));
        } else {
          reject(err);
        }
      });
      req.setTimeout(120_000, () => {
        req.destroy(new Error("API request timed out"));
      });

      const onAbort = () => req.destroy(new Error("Aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal?.removeEventListener("abort", onAbort));

      req.write(body);
      req.end();
    });
  }

  async listModels(): Promise<string[]> {
    const baseUrl = this.cfg.baseUrl.trim().replace(/\/+$/, "");
    const url = new URL(`${baseUrl}/models`);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    return new Promise<string[]>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.cfg.apiKey) {
        headers["Authorization"] = `Bearer ${this.cfg.apiKey}`;
      }

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: "GET",
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              reject(new Error(`API error ${res.statusCode}: ${data}`));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              let modelsList: string[] = [];
              const rawList = parsed.data || parsed.models || (Array.isArray(parsed) ? parsed : []);
              if (Array.isArray(rawList)) {
                modelsList = rawList
                  .map((item: any) => (typeof item === "string" ? item : (item && item.id ? String(item.id) : "")))
                  .filter((m: string) => m.length > 0);
              }
              resolve(modelsList);
            } catch (e: any) {
              reject(new Error(`Failed to parse models response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", reject);
      req.setTimeout(15_000, () => {
        req.destroy(new Error("Request timed out fetching models"));
      });
      req.end();
    });
  }

  private buildUrl(): URL {
    const base = this.cfg.baseUrl.trim().replace(/\/+$/, "");
    return new URL(`${base}/chat/completions`);
  }
}