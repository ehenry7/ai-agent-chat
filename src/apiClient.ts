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

  async chat(messages: ChatMessage[], tools?: any[]): Promise<ChatMessage> {
    const url = this.buildUrl();
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      ...(tools && tools.length ? { tools } : {}),
    });

    return new Promise<ChatMessage>((resolve, reject) => {
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
          // NOTE: keep TLS verification ON. If you truly need to skip it for an
          // internal endpoint, make it a config flag — never hardcode it.
          // rejectUnauthorized: false,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              reject(new Error(`API error res.statusCode:{res.statusCode}:res.statusCode:{data}`));
              return;
            }
            try {
              const parsed = JSON.parse(data) as ChatResponse;
              const message = parsed.choices?.[0]?.message;
              if (!message) {
                reject(new Error(`Unexpected API response: ${data}`));
                return;
              }
              resolve(message);
            } catch (e: any) {
              reject(new Error(`Failed to parse API response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", reject);
      req.setTimeout(120_000, () => {
        req.destroy(new Error("API request timed out"));
      });
      req.write(body);
      req.end();
    });
  }

  private buildUrl(): URL {
    // Strip trailing slashes, then append the endpoint path.
    const base = this.cfg.baseUrl.trim().replace(/\/+$/, "");
    return new URL(`${base}/chat/completions`);
  }
}
