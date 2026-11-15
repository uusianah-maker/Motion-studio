// Heavy work runs below normal priority (owner: the PC felt stuck). The OS call is mocked.
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { lowerPriority } from '../src/storage/priority.js';

describe('lowerPriority', () => {
  it('sets BELOW_NORMAL on the child pid; no pid or a refusal is ignored', () => {
    const calls: [number, number][] = [];
    expect(lowerPriority({ pid: 4242 }, (pid, pr) => calls.push([pid, pr]))).toBe(true);
    expect(calls).toEqual([[4242, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
    expect(lowerPriority({ pid: undefined }, () => calls.push([0, 0]))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(
      lowerPriority({ pid: 1 }, () => {
        throw new Error('EACCES');
      }),
    ).toBe(false);
  });

  it('a real child process really gets below-normal priority', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { windowsHide: true });
    try {
      expect(lowerPriority(child)).toBe(true);
      expect(os.getPriority(child.pid!)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
    } finally {
      child.kill();
    }
  });
});
