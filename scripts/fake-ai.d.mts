export interface FakeReply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
  hang?: boolean;
}
export interface FakeRequest {
  key: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  size: number;
}
export interface FakeAi {
  state: {
    requests: FakeRequest[];
    planJson: unknown;
    usage: { input: number; output: number };
    words: { word: string; start: number; end: number }[];
    duration: number;
  };
  url: string;
  queue(key: string, ...replies: FakeReply[]): void;
  count(key: string): number;
  close(): Promise<void>;
}
export function startFakeAi(): Promise<FakeAi>;
