import {
  AGENT_FINAL_STEP_NOTICE,
  AGENT_MAX_STEPS,
  AnimaChatRecordSchema,
  tools,
  ModelsManager,
  type AnimaUIMessage,
  systemPrompt,
  AnimaChatEditableFieldsSchema,
  type AnimaChatRecord,
  ChatsManager,
  getAIErrorMessage,
  isDataErrorPart,
  messagesIdGenerator,
  createMessageMetadata,
  prepareMessagesForModel,
} from '@anima/core';
import { objectKeys, required } from '@noeldemartin/utils';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import Elysia, { status } from 'elysia';
import z from 'zod';

import Auth from '../../../services/Auth';
import { mcpService, skillCatalog } from '../../../services/mcp';
import { composeMcpContext, composeSystemPrompt, mergeMcpTools } from '../../../services/mcp/chat';

function mapChat(chat: AnimaChatRecord): ApiAnimaChat {
  return {
    ...chat,
    createdAt: chat.createdAt.getTime(),
    updatedAt: chat.updatedAt.getTime(),
  };
}

export const ApiAnimaChatSchema = AnimaChatRecordSchema.extend({
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ApiAnimaChat = z.infer<typeof ApiAnimaChatSchema>;

export default new Elysia().group('chats', (app) =>
  app
    .get(
      '/',
      ({ request }) =>
        Auth.runForRequest(request, async () => {
          const chats = await ChatsManager.getChats();

          return chats.map(mapChat);
        }),
      { response: z.array(ApiAnimaChatSchema) },
    )
    .post(
      '/',
      ({ request, body: data }) =>
        Auth.runForRequest(request, async () => {
          const chat = await ChatsManager.createChat(data);

          return mapChat(chat);
        }),
      {
        body: AnimaChatEditableFieldsSchema,
        response: ApiAnimaChatSchema,
      },
    )
    .patch(
      '/:url',
      ({ request, params: { url }, body: updates }) =>
        Auth.runForRequest(request, async () => {
          const chat = await ChatsManager.getChat(url);

          if (!chat) {
            throw status(404, 'Chat not found');
          }

          await ChatsManager.updateChat(url, updates);
        }),
      {
        params: z.object({ url: z.string().brand('AnimaChatUrl') }),
        body: AnimaChatEditableFieldsSchema.partial(),
      },
    )
    .get(
      '/:url/messages',
      ({ request, params: { url } }) =>
        Auth.runForRequest(request, async () => {
          const chat = await ChatsManager.getChat(url);

          if (!chat) {
            throw status(404, 'Chat not found');
          }

          return ChatsManager.getChatMessages(chat);
        }),
      {
        params: z.object({ url: z.string().brand('AnimaChatUrl') }),
        response: z.array(z.any()),
      },
    )
    .post(
      '/:url/messages',
      ({ request, params: { url }, body: { model: modelId, message } }) =>
        Auth.runForRequest(request, async () => {
          const chat = await ChatsManager.getChat(url);
          const model = await ModelsManager.getModel(modelId);

          if (!chat) {
            throw status(404, 'Chat not found');
          }

          if (!model || model.status === 'installing') {
            throw status(404, 'Model not found');
          }

          if (message.metadata?.createdAt) {
            message.metadata.createdAt = new Date(message.metadata.createdAt);
          }

          const { languageModel, providerOptions } = await ModelsManager.createLanguageModel(modelId, {
            sessionId: chat.url,
          });

          const session = Auth.requireContextSession();
          const messages = await ChatsManager.getChatMessages(chat);
          const provider = required(await ModelsManager.getProvider(model.providerId));
          const originalMessages = [...messages, message];

          await ChatsManager.storeChatMessage(message);

          let errorMessage: string | null = null;

          const skills = model.supportsTools ? await skillCatalog.get() : [];
          const system = composeSystemPrompt(
            systemPrompt({ user: session.user, supportsTools: model.supportsTools }),
            composeMcpContext(mcpService.getInstructions(), skills),
          );
          const chatTools = mergeMcpTools(tools, mcpService.getTools());
          const result = streamText({
            tools: chatTools,
            providerOptions,
            model: languageModel,
            activeTools: model.supportsTools ? objectKeys(chatTools) : [],
            messages: await convertToModelMessages(prepareMessagesForModel(originalMessages)),
            system,
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
          });

          result.consumeStream();

          return result.toUIMessageStreamResponse({
            originalMessages,
            generateMessageId: messagesIdGenerator(chat.url),
            messageMetadata({ part }) {
              if (part.type !== 'start') {
                return;
              }

              return createMessageMetadata(model, provider);
            },
            onError(error) {
              errorMessage = getAIErrorMessage(error);

              return errorMessage;
            },
            async onFinish({ messages, responseMessage, outcome }) {
              if ((outcome.status === 'failed' || errorMessage) && !responseMessage.parts.some(isDataErrorPart)) {
                responseMessage.metadata ??= createMessageMetadata(model, provider);

                responseMessage.parts.push({
                  type: 'data-error',
                  data: errorMessage ?? getAIErrorMessage(outcome.status === 'failed' ? outcome.error : null),
                });
              }

              await Promise.all(messages.map((message) => ChatsManager.storeChatMessage(message)));
              await ChatsManager.updateChat(chat.url, {}); // touch timestamps
            },
          });
        }),
      {
        params: z.object({ url: z.string().brand('AnimaChatUrl') }),
        body: z.object({
          model: z.string().brand('ModelId'),
          message: z.any().transform((value) => value as AnimaUIMessage),
        }),
      },
    ),
);
