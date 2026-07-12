import { describe, expect, it } from 'vitest';
import { FacesGenerator } from '../faces/FacesGenerator';
import type { FaceGeneratorConfig } from '../faces/types';

function exampleGeneration(generateBasic: boolean): FaceGeneratorConfig['exampleGeneration'] {
  return {
    generateBasic,
    generateAdvanced: false,
    includeEdgeCases: false,
    maxExamples: 1,
  };
}

const files = [{
  name: 'Button.tsx',
  path: 'Button.tsx',
  content: [
    'interface ButtonProps { label: string; }',
    'export function Button({ label }: ButtonProps) { return <button>{label}</button>; }',
  ].join('\n'),
}];

describe('FacesGenerator configuration', () => {
  it('honors constructor defaults and lets a call override one nested section', async () => {
    const generator = new FacesGenerator({
      exampleGeneration: exampleGeneration(false),
    });

    const inherited = await generator.generateFace(files);
    const overridden = await generator.generateFace(files, {
      exampleGeneration: exampleGeneration(true),
    });

    expect(inherited.success).toBe(true);
    expect(inherited.face?.examples).toEqual([]);
    expect(overridden.success).toBe(true);
    expect(overridden.face?.examples).toHaveLength(1);
  });
});
