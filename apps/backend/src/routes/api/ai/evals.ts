import {
  AnimaEvalCaseSchema,
  evalPassed,
  judgeEval,
  ModelsManager,
  prepareMessagesForModel,
  runEvalChecks,
  systemPrompt,
  tools,
  type ModelId,
} from '@anima/core';
import { isDevelopment, objectKeys } from '@noeldemartin/utils';
import { convertToModelMessages, generateText, stepCountIs } from 'ai';
import Elysia, { status } from 'elysia';
import z from 'zod';

import { env } from '../../../lib/env';
import Auth from '../../../services/Auth';

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
          stopWhen: stepCountIs(10),
          temperature: 0,
        });
        const candidate = result.text.trim();
        const judge = await judgeEval({
          model: judgeModel.languageModel,
          providerOptions: judgeModel.providerOptions,
          caseData,
          candidate,
        });
        const checks = runEvalChecks(caseData.checks, candidate);

        return {
          caseId: caseData.id,
          modelId: body.modelId,
          judgeModelId: body.judgeModelId ?? body.modelId,
          prompt: caseData.prompt,
          candidate,
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
