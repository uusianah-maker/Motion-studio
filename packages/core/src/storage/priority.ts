import os from 'node:os';

/**
 * Heavy background work (FFmpeg renders / proxies / analysis, the Python engine) runs BELOW normal
 * priority, so the editor, the server and the other apps on this PC stay responsive (owner: the PC
 * felt stuck while the team worked). Best effort: a process that already exited, or a system that
 * refuses, is ignored.
 */
export function lowerPriority(child: { pid?: number | undefined }, setPriority: (pid: number, priority: number) => void = os.setPriority): boolean {
  if (!child.pid) return false;
  try {
    setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch {
    return false;
  }
}
