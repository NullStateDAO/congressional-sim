export type KeyAssignmentPlan = {
  keysNeeded: number;
  label: string;
  workerKeyIndex: (workerIndex: number) => number;
};

export function createKeyAssignmentPlan(input: {
  droplets: number;
  keyCount: number;
  reuseSingleKey: boolean;
  keyRepeat: number;
}): KeyAssignmentPlan {
  const { droplets, keyCount, reuseSingleKey, keyRepeat } = input;
  if (droplets < 1) throw new Error('Droplet count must be at least 1');
  if (keyCount < 1) throw new Error('At least one OpenRouter key is required');
  if (!Number.isInteger(keyRepeat) || keyRepeat < 1) {
    throw new Error('--key-repeat must be a positive integer');
  }
  if (reuseSingleKey && keyRepeat !== 1) {
    throw new Error('--reuse-single-key cannot be combined with --key-repeat');
  }

  if (reuseSingleKey) {
    return {
      keysNeeded: 1,
      label: 'same key installed on every worker',
      workerKeyIndex: () => 0,
    };
  }

  const keysNeeded = Math.ceil(droplets / keyRepeat);
  return {
    keysNeeded,
    label:
      keyRepeat === 1
        ? 'one key per worker'
        : `repeat each key for ${keyRepeat} worker(s)`,
    workerKeyIndex: (workerIndex) => Math.floor(workerIndex / keyRepeat),
  };
}
