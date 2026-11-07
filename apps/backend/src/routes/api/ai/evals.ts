import {
  AGENT_FINAL_STEP_NOTICE,
  AGENT_MAX_STEPS,
  AnimaEvalCaseSchema,
  evalPassed,
  judgeEval,
  ModelsManager,
  prepareMessagesForModel,
  runEvalChecks,
  systemPrompt,
  tools,
  type EvalRunMetadata,
  type ModelId,
} from '@anima/core';
import { isDevelopment, objectKeys } from '@noeldemartin/utils';
import { convertToModelMessages, generateText, stepCountIs } from 'ai';
import Elysia, { status } from 'elysia';
import z from 'zod';

import { env } from '../../../lib/env';
import Auth from '../../../services/Auth';

function extractCandidate(result: {
  content: readonly { type: string; text?: string }[];
  text: string;
  steps: readonly { text: string }[];
}): string {
  const contentText = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
  const stepText = result.steps
    .map((step) => step.text.trim())
    .filter(Boolean)
    .join('\n\n');

  return (contentText || stepText || result.text).trim();
}

export default new Elysia({ prefix: '/evals' })
  .onBeforeHandle(() => {
    if (!isDevelopment() && !env('EVALS')) {
      throw status(404, 'Not found');
    }
  })
  .post(
    '/run',
    ({ request, body }) =>
      Auth.runForRequest(request, async () => {
        const session = Auth.requireContextSession();
        const caseData = body.case;
        const model = await ModelsManager.createLanguageModel(body.modelId as ModelId, {
          sessionId: session.sessionId,
        });
        const judgeModel = body.judgeModelId
          ? await ModelsManager.createLanguageModel(body.judgeModelId as ModelId, {
              sessionId: session.sessionId,
            })
          : model;
        const system = systemPrompt({ user: session.user, supportsTools: caseData.supportsTools });
        const messages = await convertToModelMessages(prepareMessagesForModel(caseData.context));
        const result = await generateText({
          model: model.languageModel,
          providerOptions: model.providerOptions,
          system,
          messages,
          tools,
          activeTools: caseData.supportsTools ? objectKeys(tools) : [],
          prepareStep({ stepNumber }) {
            if (stepNumber < AGENT_MAX_STEPS - 1) {
              return {};
            }

            return {
              activeTools: [],
              system: `${system}\n\n${AGENT_FINAL_STEP_NOTICE}`,
            };
          },
          stopWhen: stepCountIs(AGENT_MAX_STEPS),
          temperature: 0,
        });
        const candidate = extractCandidate(result);
        const run: EvalRunMetadata = {
          steps: result.steps.length,
          maxSteps: AGENT_MAX_STEPS,
          finishReason: result.finishReason,
          toolCalls: result.toolCalls.length,
          toolErrors: result.content.filter((part) => part.type === 'tool-error').length,
          successfulTools: result.toolResults.map((toolResult) => toolResult.toolName),
          finalTextLength: candidate.length,
        };
        const judge = await judgeEval({
          model: judgeModel.languageModel,
          providerOptions: judgeModel.providerOptions,
          caseData,
          candidate,
          run,
        });
        const checks = runEvalChecks(caseData.checks, candidate, run);

        return {
          caseId: caseData.id,
          modelId: body.modelId,
          judgeModelId: body.judgeModelId ?? body.modelId,
          prompt: caseData.prompt,
          candidate,
          run,
          judge,
          checks,
          pass: evalPassed(judge, checks),
          usage: result.totalUsage,
        };
      }),
    {
      body: z.object({
        case: AnimaEvalCaseSchema,
        modelId: z.string(),
        judgeModelId: z.string().optional(),
      }),
    },
  );
