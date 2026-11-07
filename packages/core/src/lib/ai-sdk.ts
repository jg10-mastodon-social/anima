import type { AnimaChatRecord } from '@anima/core';
import { isObject, requireUrlParentDirectory, uuid } from '@noeldemartin/utils';
import type { IdGenerator } from 'ai';

export const AGENT_MAX_STEPS = 10;

export const AGENT_FINAL_STEP_NOTICE =
  'You have reached your tool-use budget. Do not call any more tools. Answer now with the information you have, and be explicit about anything you could not check.';

export function messagesIdGenerator(chatUrl: AnimaChatRecord['url']): IdGenerator {
  return () => {
    const now = new Date();

    return `${requireUrlParentDirectory(chatUrl)}${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}/chat#${uuid()}`;
  };
}

export function getAIErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  if (isObject(error) && 'lastError' in error && error.lastError) {
    return getAIErrorMessage(error.lastError);
  }

  if (isObject(error) && 'message' in error && error.message) {
    return getAIErrorMessage(error.message);
  }

  return 'An error occurred.';
}
