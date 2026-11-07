import 'soukai-bis/patch-zod';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  AnimaEvalCaseSchema,
  SYSTEM_PROMPT_VERSION,
  systemPrompt,
  type AnimaEvalCase,
  type AnimaUIMessage,
  type EvalJudgeRubric,
} from '@anima/core';

const BACKEND_URL = (process.env.ANIMA_BACKEND_URL ?? 'http://localhost:1191').replace(/\/+$/, '');
const SESSION_HEADER = 'X-Anima-Session-Id';
const SESSION_FILES = [join(homedir(), '.anima-dev', 'session.json'), join(homedir(), '.anima', 'session.json')];
const JUDGE_RUBRICS: EvalJudgeRubric[] = ['tone', 'helpfulness', 'grounding', 'privacy', 'custom'];
const TONE_PATTERN = /tone|condesc|lectur|patron|rude|disrespect|moral|apolog|insult|dismiss|belittl|sarcas/i;

interface ApiChat {
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface ApiSession {
  user: {
    name?: string;
  };
}

interface ApiModel {
  alias?: string | null;
  name: string;
  supportsTools: boolean;
  status: string;
}

type ApiMessage = Omit<AnimaUIMessage, 'metadata'> & {
  metadata?: {
    model?: string;
    provider?: string;
    createdAt?: string | number | Date;
  };
};

interface MessageEntry {
  message: AnimaUIMessage;
  index: number;
  date: Date | null;
}

const args = process.argv.slice(2);

if (args[0] === '--') {
  args.shift();
}

const { values: flags } = parseArgs({
  args,
  options: {
    chat: { type: 'string' },
    at: { type: 'string' },
    date: { type: 'string' },
    id: { type: 'string' },
    'case-id': { type: 'string' },
    text: { type: 'string' },
    issue: { type: 'string' },
    desired: { type: 'string' },
    feedback: { type: 'string' },
    tags: { type: 'string', multiple: true },
    rubric: { type: 'string' },
    out: { type: 'string' },
    tolerance: { type: 'string' },
    'list-chats': { type: 'boolean' },
    'list-messages': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'print-json': { type: 'boolean' },
    'strip-tools': { type: 'boolean' },
    tools: { type: 'boolean' },
    'no-tools': { type: 'boolean' },
    force: { type: 'boolean' },
    help: { type: 'boolean' },
  },
  allowPositionals: false,
});

function fail(message: string, code = 1): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(code);
}

function printHelp(): void {
  console.log(`
Archive an Ànima chat exchange as a negative eval case.

Usage:
  vp run evals:archive -- --list-chats
  vp run evals:archive -- --chat "Trip planning" --at "2026-11-07T15:42" --dry-run
  vp run evals:archive -- \\
    --chat "Trip planning" --at "15:42" --date 2026-11-07 \\
    --issue "Condescending and lectured me" --desired "Answer directly and stay warm"

Options:
  --chat <title|url>     Chat title or URL
  --at <timestamp>       Request timestamp (ISO, or HH:mm with --date)
  --date <YYYY-MM-DD>    Date to use when --at only contains a time
  --id <message-id>      Select the request by message ID instead of timestamp
  --case-id <id>         Override the generated case ID (also used for the filename)
  --text <substring>     Narrow requests by text
  --issue <text>         What was wrong with the response (required when writing)
  --desired <text>       What the response should do instead
  --feedback <text>      User feedback to give the judge (not sent to the model)
  --tags <tag>            Repeatable or comma-separated
  --rubric <name>        tone | helpfulness | grounding | privacy | custom
  --tolerance <seconds>  Timestamp matching tolerance (default: 120)
  --out <file>           Output file (default: evals/cases/<id>.json); inside
                         the repository it must be under evals/cases
  --list-chats           List chats
  --list-messages        List the messages in a chat
  --dry-run              Print the selected exchange without writing
  --print-json           Print the full case JSON
  --strip-tools          Store text only, omitting tool calls and their outputs
  --tools / --no-tools   Override tool support detection
  --force                Overwrite an existing case
  --help                 Show this help

Authentication:
  The backend writes ~/.anima/session.json (or ~/.anima-dev/session.json in
  development) on login. Run this script in the same environment as the backend.
  Set ANIMA_SESSION_ID to override it.
`);
}

function readSessionFile(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessionId?: unknown };

    return typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

function getSessionId(): string {
  const fromEnvironment = process.env.ANIMA_SESSION_ID?.trim();

  if (fromEnvironment) {
    return fromEnvironment;
  }

  for (const path of SESSION_FILES) {
    const sessionId = readSessionFile(path);

    if (sessionId) {
      return sessionId;
    }
  }

  fail(
    'Missing session. Set ANIMA_SESSION_ID to the value of localStorage["anima:sessionId"], ' +
      'or create ~/.anima-dev/session.json with { "sessionId": "..." }.',
  );
}

async function api<T>(path: string, sessionId: string): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BACKEND_URL}/api${path}`, {
      headers: { [SESSION_HEADER]: sessionId },
    });
  } catch {
    fail(`Could not reach the Ànima backend at ${BACKEND_URL}. Is \`vp run dev\` running?`);
  }

  if (response.status === 401) {
    fail('Session expired or invalid. Update ANIMA_SESSION_ID from localStorage["anima:sessionId"].');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');

    fail(`Request failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`);
  }

  const body = await response.text();

  return (body ? JSON.parse(body) : undefined) as T;
}

function normalizeMessage(message: ApiMessage): AnimaUIMessage {
  const createdAt = message.metadata?.createdAt;
  const date = createdAt ? new Date(createdAt) : null;
  const metadata = message.metadata
    ? {
        ...message.metadata,
        createdAt: date && !Number.isNaN(date.getTime()) ? date : undefined,
      }
    : undefined;

  return { ...message, metadata } as AnimaUIMessage;
}

function getMessageDate(message: AnimaUIMessage): Date | null {
  const createdAt = message.metadata?.createdAt;

  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return createdAt;
}

function getMessageText(message: AnimaUIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('\n');
}

function hasToolPart(message: AnimaUIMessage): boolean {
  return message.parts.some((part) => part.type.startsWith('tool-'));
}

function stripToolParts(message: AnimaUIMessage): AnimaUIMessage {
  return {
    ...message,
    parts: message.parts.filter((part) => !part.type.startsWith('tool-')),
  };
}

function preview(value: string, length = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();

  return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized;
}

function formatMessageCandidates(entries: MessageEntry[]): string {
  const lines = entries
    .slice(0, 10)
    .map(
      (entry) =>
        `- ${entry.date?.toISOString() ?? 'no timestamp'}: ${preview(getMessageText(entry.message))} (${entry.message.id})`,
    );

  if (entries.length > 10) {
    lines.push(`… and ${entries.length - 10} more`);
  }

  return lines.join('\n');
}

function resolveChat(chats: ApiChat[], query: string): ApiChat {
  const trimmed = query.trim();
  const byUrl = chats.find((chat) => chat.url === trimmed);

  if (byUrl) {
    return byUrl;
  }

  const lowerCaseQuery = trimmed.toLowerCase();
  const exactMatches = chats.filter((chat) => chat.title.toLowerCase() === lowerCaseQuery);
  const partialMatches = chats.filter((chat) => chat.title.toLowerCase().includes(lowerCaseQuery));
  const matches = exactMatches.length > 0 ? exactMatches : partialMatches;

  if (matches.length === 1) {
    return matches[0] as ApiChat;
  }

  if (matches.length > 1) {
    fail(
      `Multiple chats match "${query}":\n\n${matches.map((chat) => `- ${chat.title} (${chat.url})`).join('\n')}\n\n` +
        'Use the chat URL or a more specific title.',
      2,
    );
  }

  fail(
    `No chat matches "${query}". Available chats:\n\n${chats
      .map((chat) => `- ${chat.title} (${chat.url})`)
      .join('\n')}`,
    2,
  );
}

function parseTimestamp(at: string, date?: string): Date {
  let input = at.trim();

  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(input)) {
    const day = date?.trim() || new Date().toISOString().slice(0, 10);

    input = `${day}T${input}`;
  } else if (date) {
    input = `${date}T${input}`;
  }

  const parsed = new Date(input);

  if (Number.isNaN(parsed.getTime())) {
    fail(`Invalid timestamp "${at}". Use an ISO timestamp or HH:mm with --date.`);
  }

  return parsed;
}

function findRequest(entries: MessageEntry[]): MessageEntry {
  if (flags.id) {
    const match = entries.find((entry) => entry.message.id === flags.id);

    if (!match) {
      fail(`No message found with id "${flags.id}".`, 2);
    }

    if (match.message.role !== 'user') {
      fail(`Message "${flags.id}" is a ${match.message.role} message, not a user request.`, 2);
    }

    return match;
  }

  let candidates = entries.filter((entry) => entry.message.role === 'user');

  if (flags.text) {
    const text = flags.text.toLowerCase();

    candidates = candidates.filter((entry) => getMessageText(entry.message).toLowerCase().includes(text));

    if (candidates.length === 0) {
      fail(`No user message contains "${flags.text}".`, 2);
    }
  }

  if (!flags.at) {
    if (candidates.length === 1) {
      return candidates[0] as MessageEntry;
    }

    fail(
      `Multiple user messages match. Pass --at, --id, or a more specific --text.\n\n${formatMessageCandidates(candidates)}`,
      2,
    );
  }

  const toleranceMs = (Number(flags.tolerance ?? 120) || 120) * 1000;
  const targetDate = parseTimestamp(flags.at, flags.date);
  const timed = candidates
    .filter((entry): entry is MessageEntry & { date: Date } => entry.date !== null)
    .map((entry) => ({ entry, distance: Math.abs(entry.date.getTime() - targetDate.getTime()) }))
    .sort((a, b) => a.distance - b.distance || a.entry.index - b.entry.index);

  if (timed.length === 0) {
    fail('No user messages have timestamps. Select the request with --id instead.', 2);
  }

  const nearest = timed[0] as (typeof timed)[number];
  const secondNearest = timed[1];

  if (nearest.distance > toleranceMs) {
    fail(
      `No user message is within ${toleranceMs / 1000}s of ${targetDate.toISOString()}. ` +
        `Nearest: ${nearest.entry.date.toISOString()} (${preview(getMessageText(nearest.entry.message))}). ` +
        'Use --tolerance to widen the search or --id to select by message ID.',
      2,
    );
  }

  if (secondNearest && secondNearest.distance === nearest.distance) {
    fail(
      `Two user messages are equally close to ${targetDate.toISOString()}:\n\n${formatMessageCandidates([
        nearest.entry,
        secondNearest.entry,
      ])}\n\nUse --id to select one.`,
      2,
    );
  }

  return nearest.entry;
}

async function resolveSupportsTools(
  sessionId: string,
  context: AnimaUIMessage[],
  response: AnimaUIMessage,
): Promise<boolean> {
  if (flags.tools && flags['no-tools']) {
    fail('Use either --tools or --no-tools, not both.');
  }

  if (flags.tools) {
    return true;
  }

  if (flags['no-tools']) {
    return false;
  }

  if ([...context, response].some(hasToolPart)) {
    return true;
  }

  const modelName = response.metadata?.model;

  if (!modelName) {
    return true;
  }

  const models = await api<ApiModel[]>('/ai/models', sessionId);
  const model = models.find((candidate) => (candidate.alias || candidate.name) === modelName);

  return model?.supportsTools ?? true;
}

function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'eval'
  );
}

function createCaseId(requestedAt: Date, chatTitle: string, messageId: string): string {
  const stamp = requestedAt.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const hash = createHash('sha1').update(messageId).digest('hex').slice(0, 6);

  return `${stamp}-${slugify(chatTitle)}-${hash}`;
}

function detectRubric(issue: string): EvalJudgeRubric {
  return TONE_PATTERN.test(issue) ? 'tone' : 'custom';
}

function detectTags(value: string): string[] {
  const tags: string[] = [];

  if (TONE_PATTERN.test(value)) {
    tags.push('tone');
  }

  if (/refus|cannot|can't|won't|declin/i.test(value)) {
    tags.push('refusal');
  }

  if (/hallucin|invent|made up|wrong|incorrect|fake/i.test(value)) {
    tags.push('grounding');
  }

  if (/tool|search|pod|data/i.test(value)) {
    tags.push('tools');
  }

  if (/privacy|private|secret/i.test(value)) {
    tags.push('privacy');
  }

  return tags;
}

function splitTags(tags: string[] | undefined): string[] {
  return (tags ?? [])
    .flatMap((tag) => tag.split(','))
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function getCasesDirectory(): string {
  return process.env.EVALS_CASES_DIR
    ? resolve(process.cwd(), process.env.EVALS_CASES_DIR)
    : resolve(import.meta.dirname, '../../../../evals/cases');
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return path !== '' && path !== '..' && !path.startsWith('../');
}

// Cases hold personal POD data, so refuse paths inside the repository that git would not ignore.
function resolveOutPath(requested: string | undefined, caseId: string): string {
  const casesDirectory = getCasesDirectory();

  if (!requested) {
    return join(casesDirectory, `${caseId}.json`);
  }

  const outPath = resolve(process.cwd(), requested);
  const repositoryRoot = resolve(import.meta.dirname, '../../..');

  if (isInside(repositoryRoot, outPath) && !isInside(casesDirectory, outPath)) {
    fail(
      `Refusing to write a case inside the repository but outside ${relative(repositoryRoot, casesDirectory)}/.\n` +
        'Cases contain personal POD data; use the default path or a location outside the repository.',
      2,
    );
  }

  return outPath;
}

function printSummary(data: {
  chat: ApiChat;
  request: MessageEntry;
  response: MessageEntry;
  nextUserMessage?: MessageEntry;
  context: AnimaUIMessage[];
  prompt: { chars: number; estimatedTokens: number; hash: string };
  issue: string;
  desired?: string;
  tags: string[];
  rubric: EvalJudgeRubric;
  outPath: string;
}): void {
  const { chat, request, response, nextUserMessage, context, prompt, issue, desired, tags, rubric, outPath } = data;

  console.log(`\nChat: ${chat.title}`);
  console.log(`URL: ${chat.url}`);
  console.log(`\nRequest (${request.date?.toLocaleString() ?? 'no timestamp'}):`);
  console.log(`  ${preview(getMessageText(request.message))}`);
  console.log(`\nBad response (${response.date?.toLocaleString() ?? 'no timestamp'}):`);
  console.log(`  ${preview(getMessageText(response.message))}`);

  if (nextUserMessage) {
    console.log(`\nNext user message${flags.feedback ? '' : ' (use --feedback to store it)'}:`);
    console.log(`  ${preview(getMessageText(nextUserMessage.message))}`);
  }

  console.log(`\nContext: ${context.length} messages, ${JSON.stringify(context).length} chars`);
  console.log(
    `System prompt: v${SYSTEM_PROMPT_VERSION}, ${prompt.chars} chars (~${prompt.estimatedTokens} tokens), ` +
      `hash ${prompt.hash}`,
  );
  console.log(`\nIssue: ${issue}`);
  desired && console.log(`Desired: ${desired}`);
  tags.length > 0 && console.log(`Tags: ${tags.join(', ')}`);
  console.log(`Judge rubric: ${rubric}`);
  console.log(`Case: ${outPath}`);
}

async function main(): Promise<void> {
  if (flags.help) {
    printHelp();

    return;
  }

  const sessionId = getSessionId();
  const session = await api<ApiSession | null>('/auth/session', sessionId);

  if (!session?.user) {
    fail('Not logged in. Log in to Ànima and update ANIMA_SESSION_ID.');
  }

  if (flags['list-chats']) {
    const chats = await api<ApiChat[]>('/ai/chats', sessionId);

    if (chats.length === 0) {
      console.log('No chats found.');

      return;
    }

    for (const chat of chats) {
      console.log(`${chat.title}\n  ${chat.url}\n  updated ${new Date(chat.updatedAt).toLocaleString()}\n`);
    }

    return;
  }

  if (!flags.chat) {
    fail('Missing --chat. Use --list-chats to see available chats.');
  }

  const chats = await api<ApiChat[]>('/ai/chats', sessionId);
  const chat = resolveChat(chats, flags.chat);
  const rawMessages = await api<ApiMessage[]>(`/ai/chats/${encodeURIComponent(chat.url)}/messages`, sessionId);
  const entries: MessageEntry[] = rawMessages
    .map((message, index) => {
      const normalized = normalizeMessage(message);

      return { message: normalized, index, date: getMessageDate(normalized) };
    })
    .sort((a, b) => {
      if (a.date && b.date) {
        return a.date.getTime() - b.date.getTime() || a.index - b.index;
      }

      return a.index - b.index;
    });

  if (entries.length === 0) {
    fail(`Chat "${chat.title}" has no messages.`);
  }

  if (flags['list-messages']) {
    console.log(`\nChat: ${chat.title}\nURL: ${chat.url}\n`);

    for (const entry of entries) {
      console.log(
        `${entry.date?.toISOString() ?? 'no timestamp'} [${entry.message.role}] ` +
          `${preview(getMessageText(entry.message), 240)}`,
      );
    }

    console.log();

    return;
  }

  const request = findRequest(entries);
  const requestIndex = entries.indexOf(request);
  const afterRequest = entries.slice(requestIndex + 1);
  const nextUserOffset = afterRequest.findIndex((entry) => entry.message.role === 'user');
  const turn = nextUserOffset === -1 ? afterRequest : afterRequest.slice(0, nextUserOffset);
  const response = turn.find((entry) => entry.message.role === 'assistant');

  if (!response) {
    fail('No assistant response was found immediately after the request. Select a different request.', 2);
  }

  const nextUserMessage = nextUserOffset === -1 ? undefined : afterRequest[nextUserOffset];
  const originalContext = entries.slice(0, requestIndex + 1).map((entry) => entry.message);
  const supportsTools = await resolveSupportsTools(sessionId, originalContext, response.message);
  const stripTools = flags['strip-tools'] === true;
  const context = stripTools ? originalContext.map(stripToolParts) : originalContext;
  const badResponse = stripTools ? stripToolParts(response.message) : response.message;
  const requestedAt = request.date;

  if (!requestedAt) {
    fail('The request message has no timestamp. Select it with --id instead, or set a timestamp in the app.', 2);
  }

  const issue = flags.issue?.trim();
  const desired = flags.desired?.trim();
  const dryRun = flags['dry-run'] === true;
  const caseIssue = issue ?? '<describe what was wrong with the response>';

  if (!issue && !dryRun && !flags['print-json']) {
    fail('Missing --issue. Describe what was wrong with the response (use --dry-run to inspect it first).', 2);
  }

  const rubric = (flags.rubric ?? detectRubric(issue ?? '')) as EvalJudgeRubric;

  if (!JUDGE_RUBRICS.includes(rubric)) {
    fail(`Invalid rubric "${rubric}". Use one of: ${JUDGE_RUBRICS.join(', ')}.`);
  }

  const prompt = systemPrompt({
    user: { name: session.user.name } as Parameters<typeof systemPrompt>[0]['user'],
    supportsTools,
  });
  const promptMetrics = {
    version: SYSTEM_PROMPT_VERSION,
    hash: createHash('sha256').update(prompt).digest('hex').slice(0, 12),
    chars: prompt.length,
    estimatedTokens: Math.ceil(prompt.length / 4),
  };
  const tags = Array.from(new Set([...splitTags(flags.tags), ...detectTags(`${issue ?? ''} ${desired ?? ''}`)]));
  const caseId = flags['case-id'] ?? createCaseId(requestedAt, chat.title, request.message.id);
  const outPath = resolveOutPath(flags.out, caseId);

  const evalCase: AnimaEvalCase = {
    version: 1,
    kind: 'negative',
    id: caseId,
    createdAt: new Date().toISOString(),
    source: {
      chatUrl: chat.url,
      chatTitle: chat.title,
      requestMessageId: request.message.id,
      requestedAt: requestedAt.toISOString(),
      responseMessageId: response.message.id,
      respondedAt: response.date?.toISOString(),
      model: response.message.metadata?.model,
      provider: response.message.metadata?.provider,
    },
    user: { name: session.user.name },
    supportsTools,
    prompt: promptMetrics,
    context,
    badResponse,
    feedback: flags.feedback?.trim() || undefined,
    issue: caseIssue,
    desired,
    checks: [{ type: 'judge', rubric, avoid: caseIssue, expect: desired }],
    tags,
  };

  const contextChars = JSON.stringify(context).length;

  if (!stripTools && contextChars > 100_000) {
    console.warn(
      `\n⚠️  Context is ${contextChars} chars. Use --strip-tools to omit tool calls and outputs ` +
        'if this is a tone/response eval.\n',
    );
  }

  const parsed = AnimaEvalCaseSchema.parse(evalCase);

  printSummary({
    chat,
    request,
    response,
    nextUserMessage,
    context,
    prompt: promptMetrics,
    issue: caseIssue,
    desired,
    tags,
    rubric,
    outPath,
  });

  if (flags['print-json']) {
    console.log(`\n${JSON.stringify(parsed, null, 2)}\n`);
  }

  if (dryRun) {
    console.log('\nNot writing (--dry-run).\n');

    return;
  }

  if (existsSync(outPath) && !flags.force) {
    fail(`Case already exists at ${outPath}. Use --force to overwrite or --id to choose another ID.`);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  const relativeOutPath = relative(process.cwd(), outPath);

  console.log(`\n✅ Saved ${relativeOutPath.startsWith('..') ? outPath : relativeOutPath}\n`);
}

await main();
