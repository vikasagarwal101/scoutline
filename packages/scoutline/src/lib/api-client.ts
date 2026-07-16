/**
 * Z.AI API client for vision, search, and reader
 */

import { loadConfig, type ZaiConfig } from "./config.js";
import { ApiError, AuthError, NetworkError, TimeoutError } from "./errors.js";

// Message types for multimodal API
export interface ImageContent {
  type: "image_url";
  image_url: { url: string };
}

export interface VideoContent {
  type: "video_url";
  video_url: { url: string };
}

export interface TextContent {
  type: "text";
  text: string;
}

export type MessageContent = ImageContent | VideoContent | TextContent;

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | MessageContent[];
}

// Vision API types
export interface VisionRequest {
  model: string;
  messages: Message[];
  thinking?: { type: string };
  stream: boolean;
  temperature: number;
  top_p: number;
  max_tokens: number;
}

export interface VisionResponse {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Search API types
export interface SearchRequest {
  search_engine: "search-prime";
  search_query: string;
  count?: number;
  search_domain_filter?: string;
  search_recency_filter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
}

export interface SearchResult {
  title: string;
  content: string;
  link: string;
  media: string;
  icon: string;
  refer: string;
  publish_date?: string;
}

export interface SearchResponse {
  id: string;
  created: number;
  search_result: SearchResult[];
}

// Reader API types
export interface ReaderRequest {
  url: string;
  timeout?: number;
  no_cache?: boolean;
  return_format?: "markdown" | "text";
  retain_images?: boolean;
  no_gfm?: boolean;
  with_images_summary?: boolean;
  with_links_summary?: boolean;
}

export interface ReaderResponse {
  id: string;
  created: number;
  reader_result: {
    content: string;
    description: string;
    title: string;
    url: string;
    metadata?: Record<string, string>;
  };
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
  baseDelay: number = 1000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry auth errors or validation errors
      if (error instanceof AuthError) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Exponential backoff
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Z.AI API client
 */
export class ZaiApiClient {
  private config: ZaiConfig;

  constructor(config?: ZaiConfig) {
    this.config = config || loadConfig();
  }

  private async request<T>(endpoint: string, body: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "Accept-Language": "en-US,en",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text();
        let errorMessage = `HTTP ${response.status}: ${text}`;

        try {
          const errorJson = JSON.parse(text);
          // Handle nested error objects
          const msg = errorJson.message || errorJson.error?.message || errorJson.error;
          if (typeof msg === "string") {
            errorMessage = msg;
          } else if (typeof msg === "object") {
            errorMessage = JSON.stringify(msg);
          }
        } catch {
          // Use text as-is
        }

        if (response.status === 401 || response.status === 403) {
          throw new AuthError(errorMessage);
        }

        throw new ApiError(errorMessage, response.status);
      }

      return (await response.json()) as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof AuthError || error instanceof ApiError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new TimeoutError(this.config.timeout);
        }

        if (error.message.includes("fetch")) {
          throw new NetworkError(error.message);
        }
      }

      throw error;
    }
  }

  /**
   * Vision completions API for image/video analysis
   */
  async visionComplete(messages: Message[]): Promise<VisionResponse> {
    return withRetry(() =>
      this.request<VisionResponse>("/chat/completions", {
        model: this.config.visionModel,
        messages,
        thinking: { type: "enabled" },
        stream: false,
        temperature: this.config.temperature,
        top_p: this.config.topP,
        max_tokens: this.config.maxTokens,
      }),
    );
  }

  /**
   * Web search API
   */
  async webSearch(params: {
    query: string;
    count?: number;
    domainFilter?: string;
    recencyFilter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
  }): Promise<SearchResponse> {
    const body: SearchRequest = {
      search_engine: "search-prime",
      search_query: params.query,
      ...(params.count && { count: params.count }),
      ...(params.domainFilter && { search_domain_filter: params.domainFilter }),
      ...(params.recencyFilter && { search_recency_filter: params.recencyFilter }),
    };

    return withRetry(() => this.request<SearchResponse>("/web_search", body));
  }

  /**
   * Web reader API
   */
  async webRead(params: {
    url: string;
    format?: "markdown" | "text";
    retainImages?: boolean;
    withLinksSummary?: boolean;
    timeout?: number;
  }): Promise<ReaderResponse> {
    const body: ReaderRequest = {
      url: params.url,
      return_format: params.format || "markdown",
      retain_images: params.retainImages ?? true,
      with_links_summary: params.withLinksSummary ?? false,
      ...(params.timeout && { timeout: params.timeout }),
    };

    return withRetry(() => this.request<ReaderResponse>("/reader", body));
  }
}

// Helper functions for building multimodal messages
export function createImageContent(url: string): ImageContent {
  return { type: "image_url", image_url: { url } };
}

export function createVideoContent(url: string): VideoContent {
  return { type: "video_url", video_url: { url } };
}

export function createTextContent(text: string): TextContent {
  return { type: "text", text };
}

export function createMultimodalMessage(
  contents: MessageContent[],
  role: "user" | "system" = "user",
): Message {
  return { role, content: contents };
}
