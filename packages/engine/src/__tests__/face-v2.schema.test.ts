import { describe, expect, it } from 'vitest';
import { safeParseFaceJsonV2 } from '../schemas/face-v2.schema.ts';

describe('FaceJsonV2Schema', () => {
  it('accepts mixed JSON literal options for union props', () => {
    const result = safeParseFaceJsonV2({
      name: 'Checkbox',
      props: {
        checked: {
          type: 'union',
          options: [true, false, 'indeterminate'],
          default: null,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.props?.checked?.options).toEqual([
      true,
      false,
      'indeterminate',
    ]);
  });
});
