import { describe, expect, it } from 'vitest';
import { safeParseFaceJsonV2 } from '../schemas/face-v2.schema.ts';

describe('FaceJsonV2Schema', () => {
  it('preserves the existing Face executable preview reference through the v2 boundary', () => {
    const preview = { entryPath: '../examples/Widget.tsx', exportName: 'Interactive' };
    expect(safeParseFaceJsonV2({ name: 'Widget', preview }).data?.preview).toEqual(preview);
    expect(safeParseFaceJsonV2({ name: 'Legacy' }).data).not.toHaveProperty('preview');
  });

  it.each([null, {}, { entryPath: '/outside.tsx', exportName: 'Interactive' }, { entryPath: './Widget.tsx', exportName: '' }])('rejects an explicit invalid preview using the shared contract validator: %j', preview => {
    const result = safeParseFaceJsonV2({ name: 'Widget', preview });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['preview']);
    expect(result.error?.issues[0]?.message).toContain('Invalid Face preview reference');
  });

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
