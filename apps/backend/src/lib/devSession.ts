import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isDevelopment } from '@noeldemartin/utils';

import { ROOT_STORAGE } from './constants';
import { env } from './env';

function devSessionFile(): string | null {
  if (!isDevelopment() && !env('EVALS')) {
    return null;
  }

  return join(ROOT_STORAGE, 'session.json');
}

export async function persistDevSession(sessionId: string, webId?: string): Promise<void> {
  const path = devSessionFile();

  if (!path) {
    return;
  }

  try {
    const directory = dirname(path);

    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => {});
    await writeFile(path, `${JSON.stringify({ sessionId, webId, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    console.error('Failed to persist the development session file', error);
  }
}

export async function clearDevSession(sessionId: string): Promise<void> {
  const path = devSessionFile();

  if (!path) {
    return;
  }

  try {
    const contents = await readFile(path, 'utf8');
    const parsed = JSON.parse(contents) as { sessionId?: unknown };

    if (parsed.sessionId === sessionId) {
      await rm(path, { force: true });
    }
  } catch {
    // The session file is missing or unreadable; there is nothing to clear.
  }
}
