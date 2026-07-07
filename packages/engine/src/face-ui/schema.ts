import { z } from 'zod';
import {
  FACE_UI_SCHEMA,
  FACE_UI_SCHEMA_VERSION,
} from './types';

const FaceJsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const FaceJsonValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([FaceJsonPrimitiveSchema, z.array(FaceJsonValueSchema), z.record(z.string(), FaceJsonValueSchema)])
);

export const FaceUiActionRefSchema = z.object({
  $action: z.string().min(1),
  args: FaceJsonValueSchema.optional(),
});

export const FaceUiRefSchema = z.object({
  $ref: z.string().min(1),
});

export const FaceUiValueSchema: z.ZodTypeAny = z.union([FaceJsonValueSchema, FaceUiActionRefSchema, FaceUiRefSchema]);

export const FaceUiNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    key: z.string().optional(),
    props: z.record(z.string(), FaceUiValueSchema).optional(),
    children: z
      .array(z.union([FaceUiNodeSchema, FaceJsonPrimitiveSchema]))
      .optional(),
  })
);

export const FaceUiDocSchema = z.object({
  schema: z.literal(FACE_UI_SCHEMA),
  'schema-version': z.literal(FACE_UI_SCHEMA_VERSION),
  root: FaceUiNodeSchema,
  meta: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  state: z.record(z.string(), FaceJsonPrimitiveSchema).optional(),
});

export function isFaceUiDoc(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === FACE_UI_SCHEMA
    && (value as Record<string, unknown>)['schema-version'] === FACE_UI_SCHEMA_VERSION
    && (value as Record<string, unknown>).root,
  );
}
