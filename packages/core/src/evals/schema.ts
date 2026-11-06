import z from 'zod';

import type { AnimaUIMessage } from '../lib/chat';

const AnimaUIMessageSchema = z.custom<AnimaUIMessage>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'role' in value &&
    'parts' in value &&
    Array.isArray((value as { parts?: unknown }).parts),
  { message: 'Invalid Ànima chat message' },
);

export const EvalCheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('contains'),
    value: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('notContains'),
    value: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('judge'),
    rubric: z.enum(['tone', 'helpfulness', 'grounding', 'privacy', 'custom']),
    avoid: z.string().optional(),
    expect: z.string().optional(),
    description: z.string().optional(),
  }),
]);

export const AnimaEvalCaseSchema = z.object({
  version: z.literal(1),
  kind: z.literal('negative'),
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  source: z.object({
    chatUrl: z.url(),
    chatTitle: z.string(),
    requestMessageId: z.string().min(1),
    requestedAt: z.iso.datetime(),
    responseMessageId: z.string().optional(),
    respondedAt: z.iso.datetime().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
  }),
  user: z.object({
    name: z.string().optional(),
  }),
  supportsTools: z.boolean(),
  prompt: z.object({
    version: z.number(),
    hash: z.string(),
    chars: z.number(),
    estimatedTokens: z.number(),
  }),
  context: z.array(AnimaUIMessageSchema),
  badResponse: AnimaUIMessageSchema,
  feedback: z.string().optional(),
  issue: z.string().min(1),
  desired: z.string().optional(),
  checks: z.array(EvalCheckSchema).min(1),
  tags: z.array(z.string()),
});

export type AnimaEvalCase = z.infer<typeof AnimaEvalCaseSchema>;
export type EvalCheck = z.infer<typeof EvalCheckSchema>;
export type EvalJudgeRubric = Extract<EvalCheck, { type: 'judge' }>['rubric'];
