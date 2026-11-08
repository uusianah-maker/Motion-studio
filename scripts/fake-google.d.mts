export interface FakeGoogleState {
  user: { sub: string; email: string; email_verified: boolean | string; name: string };
  deny: boolean;
  grantDrive: boolean;
  tokenStatus: number;
  mutateClaims: ((c: Record<string, unknown>) => Record<string, unknown>) | null;
  authRequests: Record<string, string>[];
  tokenRequests: Record<string, string>[];
}
export interface FakeGoogle {
  state: FakeGoogleState;
  port: number;
  authUrl: string;
  tokenUrl: string;
  forget(sub: string): void;
  close(): Promise<void>;
}
export function startFakeGoogle(opts: { clientId: string; clientSecret: string; host?: string; publicHost?: string }): Promise<FakeGoogle>;
