import { describe, expect, it } from 'vitest';

import { deterministicId, stableJson } from '../src/lib/hash.js';

describe('stable identifiers', () => {
  it('does not depend on object key order', () => {
    expect(stableJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(deterministicId({ b: 2, a: 1 })).toBe(
      deterministicId({ a: 1, b: 2 }),
    );
  });
});
