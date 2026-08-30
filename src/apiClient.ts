import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface ApiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Total attempts per chat() call for retriable errors. Default 3 (2 retries). */
  maxAttempts?: number;
  /** Base backoff in ms between retries; actual delay is retryDelayMs * attempt. Default 1500. */
  retryDelayMs?: number;
  /** Optional callback fired before each retry (e.g. for logging). */
  onRetry?: (info: { attempt: number; maxAttempts: number; error: string; delayMs: number }) => void;
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

/**
 * Decides whether a failed chat attempt is worth retrying: timeouts, dropped
 * sockets, DNS hiccups, and rate-limit/gateway statuses. User aborts and
 * other 4xx client errors are never retried. Exported for unit testing.
 */
export function isRetriableError(err: unknown): boolean {
  const e = err as any;
  const retriableCodes = ["ETIMEDOUT", "ECONNRESET", "EPIPE", "EAI_AGAIN", "ENOTFOUND"];
  if (e && typeof e.code === "string" && retriableCodes.includes(e.code)) {
    return true;
  }
  const msg = String(e?.message ?? err ?? "");
  if (msg.includes("Aborted")) {
    return false;
  }
  if (msg.includes("timed out")) {
    return true; // our own "API request timed out" guard and transport timeouts
  }
  if (msg.includes("socket hang up")) {
    return true;
  }
  const statusMatch = msg.match(/API error (\d{3})/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
  }
  return false;
}

export class ApiClient {
  constructor(private cfg: ApiConfig) {}

  /**
   * Chat completion with retry: timeouts and transient failures are retried
   * up to maxAttempts (default 3). User aborts are never retried.
   */
  async chat(messages: ChatMessage[], tools?: any[], signal?: AbortSignal): Promise<ChatMessage> {
    const maxAttempts = Math.max(1, this.cfg.maxAttempts ?? 3);
    const baseDelay = this.cfg.retryDelayMs ?? 1500;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.chatOnce(messages, tools, signal);
      } catch (err) {
        lastError = err;
        const aborted = Boolean(signal?.aborted) || String((err as any)?.message ?? err).includes("Aborted");
        if (aborted || attempt >= maxAttempts || !isRetriableError(err)) {
          throw err;
        }
        const delayMs = baseDelay * attempt;
        if (this.cfg.onRetry) {
          this.cfg.onRetry({ attempt, maxAttempts, error: String((err as any)?.message ?? err), delayMs });
        }
        // Sleep, but wake up immediately if the user hits Stop.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, delayMs);
          function finish(): void {
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
          }
          signal?.addEventListener("abort", finish, { once: true });
        });
      }
    }
    throw lastError; // unreachable: the loop always returns or throws
  }

  private async chatOnce(messages: ChatMessage[], tools?: any[], signal?: AbortSignal): Promise<ChatMessage> {
    const url = this.buildUrl();
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
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
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              reject(new Error(`API error ${res.statusCode}: ${data}`));
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