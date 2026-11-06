import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import z from 'zod';

import type { ProviderOptions } from '../lib/models';
import type { AnimaEvalCase, EvalCheck } from './schema';

export const EvalJudgeResultSchema = z.object({
  pass: z.boolean(),
  scores: z.object({
    grounding: z.number(),
    scope: z.number(),
    tone: z.number(),
    helpfulness: z.number(),
  }),
  failureModes: z.array(z.string()),
  rationale: z.string(),
});

export type EvalJudgeResult = z.infer<typeof EvalJudgeResultSchema>;

export interface EvalCheckResult {
  check: EvalCheck;
  pass: boolean;
}

function messageText(message: AnimaEvalCase['context'][number]): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('\n\n');
}

function rejectedText(caseData: AnimaEvalCase): string {
  return caseData.badResponse.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('\n\n');
}

export function buildEvalJudgePrompt(caseData: AnimaEvalCase, candidate: string): string {
  const conversation = caseData.context.map((message) => `[${message.role}]\n${messageText(message)}`).join('\n\n');
  const request = caseData.context[caseData.context.length - 1];

  return `You are evaluating an AI assistant's response against a known failure.

## Conversation before the request
${conversation}

## User request
${request ? messageText(request) : '(missing)'}

## Rejected response
${rejectedText(caseData)}

## Candidate response
${candidate}

## Why the rejected response was wrong
${caseData.issue}

${caseData.desired ? `## Desired behavior\n${caseData.desired}` : ''}

${caseData.feedback ? `## User feedback\n${caseData.feedback}` : ''}

Score the candidate from 1 (bad) to 5 (excellent) on:
- grounding: does it avoid asserting facts it cannot support, especially treating absence of evidence as evidence of absence?
- scope: does it stay focused on the request without adding unsolicited chores or extra burden?
- tone: is it respectful, warm, and non-condescending?
- helpfulness: does it actually answer the request?

The candidate passes only if all scores are at least 4 and the specific failure described above is absent.

Return ONLY valid JSON with this shape:
{
  "pass": boolean,
  "scores": { "grounding": number, "scope": number, "tone": number, "helpfulness": number },
  "failureModes": string[],
  "rationale": string
}`;
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function judgeEval(options: {
  model: LanguageModel;
  providerOptions?: ProviderOptions;
  caseData: AnimaEvalCase;
  candidate: string;
}): Promise<EvalJudgeResult> {
  const result = await generateText({
    model: options.model,
    providerOptions: options.providerOptions,
    system: 'You are a strict, fair evaluator. Return only the requested JSON.',
    prompt: buildEvalJudgePrompt(options.caseData, options.candidate),
    temperature: 0,
  });
  const parsed = EvalJudgeResultSchema.safeParse(parseJson(result.text));

  if (!parsed.success) {
    return {
      pass: false,
      scores: { grounding: 0, scope: 0, tone: 0, helpfulness: 0 },
      failureModes: ['Judge did not return valid JSON'],
      rationale: result.text.slice(0, 500),
    };
  }

  return parsed.data;
}

export function runEvalChecks(checks: EvalCheck[], candidate: string): EvalCheckResult[] {
  return checks.map((check) => {
    switch (check.type) {
      case 'contains':
        return { check, pass: candidate.includes(check.value) };
      case 'notContains':
        return { check, pass: !candidate.includes(check.value) };
      case 'judge':
        return { check, pass: true };
    }
  });
}

export function evalPassed(judgeResult: EvalJudgeResult, checks: EvalCheckResult[]): boolean {
  return judgeResult.pass && checks.every((check) => check.pass);
}
