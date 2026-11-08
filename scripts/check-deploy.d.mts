export interface DeployLine {
  level: 'OK' | 'WARN' | 'FAIL' | 'INFO';
  what: string;
  detail: string;
}
export function checkDeploy(env: Record<string, string | undefined>, publicUrl: string | null, fetchImpl?: typeof fetch): Promise<DeployLine[]>;
