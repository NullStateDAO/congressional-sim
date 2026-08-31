import { describe, expect, it } from 'vitest';

import { createKeyAssignmentPlan } from '../src/lib/key-assignment.js';

describe('OpenRouter key assignment', () => {
  it('assigns one key per worker by default', () => {
    const plan = createKeyAssignmentPlan({
      droplets: 3,
      keyCount: 3,
      reuseSingleKey: false,
      keyRepeat: 1,
    });

    expect(plan.keysNeeded).toBe(3);
    expect([0, 1, 2].map((index) => plan.workerKeyIndex(index))).toEqual([
      0, 1, 2,
    ]);
  });

  it('can repeat each key across two workers', () => {
    const plan = createKeyAssignmentPlan({
      droplets: 6,
      keyCount: 3,
      reuseSingleKey: false,
      keyRepeat: 2,
    });

    expect(plan.keysNeeded).toBe(3);
    expect([0, 1, 2, 3, 4, 5].map((index) => plan.workerKeyIndex(index))).toEqual(
      [0, 0, 1, 1, 2, 2],
    );
  });

  it('can repeat four keys across eight workers', () => {
    const plan = createKeyAssignmentPlan({
      droplets: 8,
      keyCount: 4,
      reuseSingleKey: false,
      keyRepeat: 2,
    });

    expect(plan.keysNeeded).toBe(4);
    expect(
      Array.from({ length: 8 }, (_, index) => plan.workerKeyIndex(index)),
    ).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('keeps the explicit single-key mode', () => {
    const plan = createKeyAssignmentPlan({
      droplets: 6,
      keyCount: 1,
      reuseSingleKey: true,
      keyRepeat: 1,
    });

    expect(plan.keysNeeded).toBe(1);
    expect([0, 1, 2, 3, 4, 5].map((index) => plan.workerKeyIndex(index))).toEqual(
      [0, 0, 0, 0, 0, 0],
    );
  });

  it('rejects ambiguous single-key repeat mode', () => {
    expect(() =>
      createKeyAssignmentPlan({
        droplets: 6,
        keyCount: 3,
        reuseSingleKey: true,
        keyRepeat: 2,
      }),
    ).toThrow(/cannot be combined/);
  });
});
