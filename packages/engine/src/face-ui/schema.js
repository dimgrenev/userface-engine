import { z } from 'zod';
const FaceJsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const FaceJsonValueSchema = z.lazy(() => z.union([FaceJsonPrimitiveSchema, z.array(FaceJsonValueSchema), z.record(z.string(), FaceJsonValueSchema)]));
export const FaceUiActionRefSchema = z.object({
    $action: z.string().min(1),
    args: FaceJsonValueSchema.optional(),
});
export const FaceUiRefSchema = z.object({
    $ref: z.string().min(1),
});
export const FaceUiValueSchema = z.union([FaceJsonValueSchema, FaceUiActionRefSchema, FaceUiRefSchema]);
export const FaceUiNodeSchema = z.lazy(() => z.object({
    type: z.string().min(1),
    key: z.string().optional(),
    props: z.record(z.string(), FaceUiValueSchema).optional(),
    children: z
        .array(z.union([FaceUiNodeSchema, FaceJsonPrimitiveSchema]))
        .optional(),
}));
export const FaceUiDocSchema = z.object({
    version: z.literal('ui@1'),
    root: FaceUiNodeSchema,
    meta: z
        .object({
        name: z.string().optional(),
        description: z.string().optional(),
    })
        .optional(),
});
