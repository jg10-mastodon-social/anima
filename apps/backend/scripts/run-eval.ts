import '../src/lib/soukai-bis';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  AGENT_FINAL_STEP_NOTICE,
  AGENT_MAX_STEPS,
  AIProviderSchema,
  AnimaEvalCaseSchema,
  AnthropicModelsProviderFactory,
  evalPassed,
  getAIErrorMessage,
  GoogleModelsProviderFactory,
  InstalledModelSchema,
  judgeEval,
  OllamaModelsProviderFactory,
  OpenAIModelsProviderFactory,
  OpenCodeGoModelsProviderFactory,
  prepareMessagesForModel,
  runEvalChecks,
  setAuthProvider,
  SYSTEM_PROMPT_VERSION,
  systemPrompt,
  tools,
  type AIProvider,
  type AnimaEvalCase,
  type AuthProvider,
  type EvalCheckResult,
  type EvalJudgeResult,
  type EvalRunMetadata,
  type InstalledModel,
  type ModelsProviderFactory,
} from '@anima/core';
import { objectKeys } from '@noeldemartin/utils';
import { convertToModelMessages, generateText, stepCountIs } from 'ai';
import { runWithEngine, SolidEngine } from 'soukai-bis';

const BACKEND_URL = (process.env.ANIMA_BACKEND_URL ?? 'http://localhost:1191').replace(/\/+$/, '');
const SESSION_HEADER = 'X-Anima-Session-Id';
const SESSION_FILES = [join(homedir(), '.anima-dev', 'session.json'), join(homedir(), '.anima', 'session.json')];

const args = process.argv.slice(2);

if (args[0] === '--') {
  args.shift();
}

const { values: flags } = parseArgs({
  args,
  options: {
    case: { type: 'string' },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    'storage-root': { type: 'string' },
    'prompt-file': { type: 'string' },
    'prompt-append-file': { type: 'string' },
    backend: { type: 'string' },
    live: { type: 'boolean' },
    debug: { type: 'boolean' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
  allowPositionals: false,
});

interface StorageData {
  providers: AIProvider[];
  models: InstalledModel[];
}

interface EvalRunOutput {
  caseId: string;
  createdAt: string;
  model: { id?: string; name: string; alias?: string | null };
  judgeModel: { id?: string; name: string; alias?: string | null };
  prompt: AnimaEvalCase['prompt'];
  candidate: string;
  run: EvalRunMetadata;
  judge: EvalJudgeResult;
  checks: EvalCheckResult[];
  pass: boolean;
  usage: unknown;
}

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`
Run one Ànima eval case and judge the response.

Usage:
  vp run evals:run -- --case evals/cases/<id>.json
  vp run evals:run -- --case evals/cases/<id>.json --live
  vp run evals:run -- --case evals/cases/<id>.json --live --model D4F --judge-model D4F

Options:
  --case <path>          Eval case JSON file (required)
  --live                 Run with live POD tools through the backend proxy
  --model <id|alias>     Model to evaluate (default: case source model)
  --judge-model <id>     Model to judge with (default: same as --model)
  --storage-root <path>  Ànima storage root containing providers/ and models/
  --prompt-file <path>   Replace the system prompt with a file
  --prompt-append-file   Append a file to the current system prompt
  --backend <url>        Backend URL (default: http://localhost:1191)
  --out <path>           Result JSON path (default: evals/results/<id>-<timestamp>.json)
  --help                 Show this help

Live mode reads the session file the backend writes on login
(~/.anima/session.json, or ~/.anima-dev/session.json in development). Run this
command in the same environment as the backend. ANIMA_SESSION_ID overrides it.
The storage root is usually ~/.anima or ~/.anima-dev. If the backend runs inside
proot, run this command inside proot or set ANIMA_STORAGE_ROOT.
`);
}

function readJsonFiles<T>(directory: string, parse: (value: unknown) => T | null): T[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      try {
        const parsed = parse(JSON.parse(readFileSync(join(directory, file), 'utf8')));

        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function readStorageRoot(root: string): StorageData {
  if (!existsSync(root)) {
    return { providers: [], models: [] };
  }

  const providers: AIProvider[] = [];
  const models: InstalledModel[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const userRoot = join(root, entry.name);

    providers.push(
      ...readJsonFiles(join(userRoot, 'providers'), (value) => {
        const parsed = AIProviderSchema.safeParse(value);

        return parsed.success ? parsed.data : null;
      }),
    );
    models.push(
      ...readJsonFiles(join(userRoot, 'models'), (value) => {
        const parsed = InstalledModelSchema.safeParse(value);

        return parsed.success ? parsed.data : null;
      }),
    );
  }

  return { providers, models };
}

function modelMatches(model: InstalledModel, query: string): boolean {
  const normalized = query.toLowerCase();

  return [model.id, model.alias, model.name]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase() === normalized);
}

function findModel(models: InstalledModel[], query?: string, fallback?: string): InstalledModel {
  if (query) {
    const model = models.find((candidate) => modelMatches(candidate, query));

    if (!model) {
      fail(
        `Model "${query}" not found. Available models: ${models
          .map((candidate) => candidate.alias || candidate.name)
          .join(', ')}`,
      );
    }

    return model;
  }

  if (fallback) {
    const model = models.find(
      (candidate) =>
        candidate.alias?.toLowerCase() === fallback.toLowerCase() ||
        candidate.name.toLowerCase() === fallback.toLowerCase(),
    );

    if (model) {
      return model;
    }
  }

  if (models.length === 0) {
    fail('No installed models found. Set ANIMA_STORAGE_ROOT to the backend storage root.');
  }

  return models[0] as InstalledModel;
}

function findProvider(providers: AIProvider[], model: InstalledModel): AIProvider {
  const provider = providers.find((candidate) => candidate.id === model.providerId);

  if (!provider) {
    fail(`Provider "${model.providerId}" not found for model "${model.name}".`);
  }

  return provider;
}

function createFactory(type: string): ModelsProviderFactory {
  switch (type) {
    case 'anthropic':
      return new AnthropicModelsProviderFactory('server');
    case 'google':
      return new GoogleModelsProviderFactory('server');
    case 'openai':
      return new OpenAIModelsProviderFactory('server');
    case 'ollama':
      return new OllamaModelsProviderFactory('server');
    case 'opencode-go':
      return new OpenCodeGoModelsProviderFactory('server');
    default:
      fail(`Unsupported provider type "${type}".`);
  }
}

function getStorageRoots(): string[] {
  return Array.from(
    new Set(
      [process.env.ANIMA_STORAGE_ROOT, join(homedir(), '.anima'), join(homedir(), '.anima-dev')].filter(
        (value): value is string => !!value,
      ),
    ),
  );
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
    'Live mode needs a session. Set ANIMA_SESSION_ID to localStorage["anima:sessionId"] ' +
      'or create ~/.anima-dev/session.json with { "sessionId": "..." }.',
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const backendUrl = (flags.backend ?? BACKEND_URL).replace(/\/+$/, '');
  let response: Response;

  try {
    response = await fetch(`${backendUrl}/api${path}`, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        [SESSION_HEADER]: getSessionId(),
      },
    });
  } catch {
    fail(`Could not reach the Ànima backend at ${backendUrl}. Is \`vp run dev\` running?`);
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

function createProxyFetch(sessionId: string): AuthProvider['fetch'] {
  const backendUrl = (flags.backend ?? BACKEND_URL).replace(/\/+$/, '');

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), backendUrl), init);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();

    return fetch(`${backendUrl}/api/auth/proxy`, {
      method: 'POST',
      headers: {
        [SESSION_HEADER]: sessionId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: request.url,
        init: {
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          body,
        },
      }),
    });
  }) as AuthProvider['fetch'];
}

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

function buildPrompt(
  caseData: AnimaEvalCase,
  user: Parameters<typeof systemPrompt>[0]['user'],
): { text: string; metrics: AnimaEvalCase['prompt'] } {
  const base = systemPrompt({ user, supportsTools: caseData.supportsTools });
  const replacement = flags['prompt-file'] ? readFileSync(resolve(process.cwd(), flags['prompt-file']), 'utf8') : base;
  const append = flags['prompt-append-file']
    ? readFileSync(resolve(process.cwd(), flags['prompt-append-file']), 'utf8')
    : '';
  const text = append ? `${replacement.trim()}\n\n${append.trim()}` : replacement.trim();

  return {
    text,
    metrics: {
      version: SYSTEM_PROMPT_VERSION,
      hash: createHash('sha256').update(text).digest('hex').slice(0, 12),
      chars: text.length,
      estimatedTokens: Math.ceil(text.length / 4),
    },
  };
}

async function runCase(caseData: AnimaEvalCase, live: boolean): Promise<EvalRunOutput> {
  const storage = flags['storage-root']
    ? readStorageRoot(resolve(process.cwd(), flags['storage-root']))
    : getStorageRoots().reduce<StorageData>(
        (result, root) => {
          const data = readStorageRoot(root);

          return {
            providers: [...result.providers, ...data.providers],
            models: [...result.models, ...data.models],
          };
        },
        { providers: [], models: [] },
      );
  const model = findModel(storage.models, flags.model, caseData.source.model);
  const provider = findProvider(storage.providers, model);
  const languageModel = await createFactory(provider.type).createLanguageModel(provider, model.name);
  const messages = await convertToModelMessages(prepareMessagesForModel(caseData.context));

  console.log(`\nCase: ${caseData.id}`);
  console.log(`Model: ${model.alias || model.name} (${model.name}) via ${provider.name}`);
  console.log(`Mode: ${live ? 'live (POD tools via backend proxy)' : 'local (tools disabled)'}`);

  let user = { name: caseData.user.name } as Parameters<typeof systemPrompt>[0]['user'];
  let proxyFetch: AuthProvider['fetch'] | undefined;

  if (live) {
    const session = await api<{ user: Parameters<typeof systemPrompt>[0]['user'] } | null>('/auth/session');

    if (!session?.user) {
      fail('Not logged in. Log in to Ànima and update ANIMA_SESSION_ID.');
    }

    user = session.user;
    proxyFetch = createProxyFetch(getSessionId());
    setAuthProvider({
      getUser: () => user,
      refreshProfile: async () => {},
      getClientId: () => `${flags.backend ?? BACKEND_URL}/clientid.jsonld`,
      fetch: proxyFetch,
    });
  }

  const prompt = buildPrompt(caseData, user);

  console.log(
    `Prompt: v${prompt.metrics.version}, ${prompt.metrics.chars} chars (~${prompt.metrics.estimatedTokens} tokens)`,
  );
  console.log('\nRunning candidate...\n');

  const result = await (async () => {
    try {
      return proxyFetch
        ? await runWithEngine(new SolidEngine({ fetch: proxyFetch }), () =>
            generateText({
              model: languageModel.languageModel,
              providerOptions: languageModel.providerOptions,
              system: prompt.text,
              messages,
              tools,
              activeTools: caseData.supportsTools ? objectKeys(tools) : [],
              prepareStep({ stepNumber }) {
                if (stepNumber < AGENT_MAX_STEPS - 1) {
                  return {};
                }

                return {
                  activeTools: [],
                  system: `${prompt.text}\n\n${AGENT_FINAL_STEP_NOTICE}`,
                };
              },
              stopWhen: stepCountIs(AGENT_MAX_STEPS),
              temperature: 0,
            }),
          )
        : await generateText({
            model: languageModel.languageModel,
            providerOptions: languageModel.providerOptions,
            system: prompt.text,
            messages,
            tools,
            activeTools: [],
            stopWhen: stepCountIs(2),
            temperature: 0,
          });
    } catch (error) {
      fail(`Candidate generation failed: ${getAIErrorMessage(error)}`);
    }
  })();

  if (flags.debug) {
    console.log('--- Debug ---\n');
    console.log(
      JSON.stringify(
        {
          content: result.content.map((part) => ({
            type: part.type,
            textLength: 'text' in part && typeof part.text === 'string' ? part.text.length : undefined,
          })),
          steps: result.steps.map((step) => ({
            textLength: step.text.length,
            contentLength: step.content.length,
            finishReason: step.finishReason,
            toolCalls: step.toolCalls.length,
          })),
          responseMessages: result.responseMessages.map((message) => ({
            role: message.role,
            content: Array.isArray(message.content) ? message.content.map((part) => part.type) : typeof message.content,
          })),
          textLength: result.text.length,
          finishReason: result.finishReason,
        },
        null,
        2,
      ),
    );
    console.log();
  }

  const candidate = extractCandidate(result);
  const run: EvalRunMetadata = {
    steps: result.steps.length,
    maxSteps: proxyFetch ? AGENT_MAX_STEPS : 2,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls.length,
    finalTextLength: candidate.length,
  };

  console.log('--- Candidate ---\n');
  console.log(candidate.length > 0 ? candidate : '(empty response)');
  console.log(
    `\nRun: ${run.steps}/${run.maxSteps} steps, finish=${run.finishReason}, ` +
      `tools=${run.toolCalls}, text=${run.finalTextLength}\n`,
  );
  console.log('Judging...\n');

  const judgeModel = findModel(storage.models, flags['judge-model'], flags.model ?? caseData.source.model);
  const judgeProvider = findProvider(storage.providers, judgeModel);
  const judgeLanguageModel =
    judgeModel.id === model.id
      ? languageModel
      : await createFactory(judgeProvider.type).createLanguageModel(judgeProvider, judgeModel.name);
  const judge = await (async () => {
    try {
      return await judgeEval({
        model: judgeLanguageModel.languageModel,
        providerOptions: judgeLanguageModel.providerOptions,
        caseData,
        candidate,
        run,
      });
    } catch (error) {
      fail(`Judge failed: ${getAIErrorMessage(error)}`);
    }
  })();
  const checks = runEvalChecks(caseData.checks, candidate, run);

  return {
    caseId: caseData.id,
    createdAt: new Date().toISOString(),
    model: { id: model.id, name: model.name, alias: model.alias ?? null },
    judgeModel: { id: judgeModel.id, name: judgeModel.name, alias: judgeModel.alias ?? null },
    prompt: prompt.metrics,
    candidate,
    run,
    judge,
    checks,
    pass: evalPassed(judge, checks),
    usage: result.totalUsage,
  };
}

async function main(): Promise<void> {
  if (flags.help) {
    printHelp();

    return;
  }

  if (!flags.case) {
    fail('Missing --case. Pass the path to an eval case JSON file.');
  }

  const casePath = resolve(process.cwd(), flags.case);
  const caseData: AnimaEvalCase = AnimaEvalCaseSchema.parse(JSON.parse(readFileSync(casePath, 'utf8')));
  const output = await runCase(caseData, flags.live === true);
  const resultsDirectory = resolve(import.meta.dirname, '../../../evals/results');
  const outPath = flags.out
    ? resolve(process.cwd(), flags.out)
    : join(resultsDirectory, `${caseData.id}-${output.createdAt.replace(/[:.]/g, '-')}.json`);

  console.log('--- Judge ---\n');
  console.log(`Pass: ${output.pass ? '✅ yes' : '❌ no'}`);
  console.log(`Scores: ${JSON.stringify(output.judge.scores)}`);

  if (output.judge.failureModes.length > 0) {
    console.log(`Failure modes: ${output.judge.failureModes.join(', ')}`);
  }

  console.log(`Rationale: ${output.judge.rationale}`);

  if (output.checks.some((check) => !check.pass)) {
    console.log('\nFailed deterministic checks:');
    output.checks.filter((check) => !check.pass).forEach((check) => console.log(`- ${JSON.stringify(check.check)}`));
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`\nResult: ${outPath}\n`);

  if (!output.pass) {
    process.exitCode = 1;
  }
}

await main();
