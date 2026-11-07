import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, ToolExecutionOptions } from 'ai';

import type { McpServerConfig, ResolvedMcpConfig } from './config';
import { normalizeMcpToolResult } from './normalize';

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const STDIO_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'NODE_ENV',
  'CAIRN_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
];
const STDIO_ENV_PREFIXES = ['LC_', 'XDG_'];

export interface McpClientLike {
  readonly instructions?: string;
  tools(): Promise<Record<string, Tool>>;
  close(): Promise<void>;
}

export type McpServerDiagnostic =
  | { server: string; status: 'started'; toolCount: number }
  | { server: string; status: 'failed'; error: string };

export interface McpServiceOptions {
  createClient?: (server: string, config: McpServerConfig & { enabled: true }) => Promise<McpClientLike>;
  logger?: Pick<Console, 'warn' | 'info'>;
  callTimeoutMs?: number;
}

interface StartedServer {
  server: string;
  tools: Record<string, Tool>;
  instructions?: string;
}

export class McpService {
  private readonly createClient: NonNullable<McpServiceOptions['createClient']>;
  private readonly logger: Pick<Console, 'warn' | 'info'>;
  private readonly callTimeoutMs: number;
  private clients: McpClientLike[] = [];
  private tools: Record<string, Tool> = {};
  private instructions: string[] = [];
  private diagnostics: McpServerDiagnostic[] = [];
  private started = false;

  constructor(options: McpServiceOptions = {}) {
    this.createClient = options.createClient ?? createDefaultMcpClient;
    this.logger = options.logger ?? console;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  async start(config: ResolvedMcpConfig): Promise<void> {
    if (!config.enabled || this.started) {
      return;
    }

    const servers = Object.entries(config.servers);

    if (servers.length === 0) {
      return;
    }

    this.started = true;

    const started: StartedServer[] = [];

    for (const [server, serverConfig] of servers) {
      try {
        const client = await this.createClient(server, serverConfig);

        this.clients.push(client);

        const tools = await client.tools();

        started.push({ server, tools, instructions: client.instructions });
        this.diagnostics.push({ server, status: 'started', toolCount: Object.keys(tools).length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        this.diagnostics.push({ server, status: 'failed', error: message });
        this.logger.warn(`Failed to start MCP server "${server}": ${message}`);
      }
    }

    this.tools = mergeTools(started, this.callTimeoutMs);
    this.instructions = started
      .filter(({ instructions }) => instructions !== undefined && instructions.trim() !== '')
      .map(({ server, instructions }) => `MCP server "${server}" instructions:\n${instructions}`);
  }

  getTools(): Record<string, Tool> {
    return this.tools;
  }

  getInstructions(): string {
    return this.instructions.join('\n\n');
  }

  getDiagnostics(): McpServerDiagnostic[] {
    return [...this.diagnostics];
  }

  async close(): Promise<void> {
    const clients = this.clients;

    this.clients = [];
    this.tools = {};
    this.instructions = [];
    this.diagnostics = [];
    this.started = false;

    for (const client of clients) {
      try {
        await client.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        this.logger.warn(`Failed to close MCP client: ${message}`);
      }
    }
  }
}

export function buildStdioEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of STDIO_ENV_KEYS) {
    const value = process.env[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }

    if (STDIO_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

async function createDefaultMcpClient(
  _server: string,
  config: McpServerConfig & { enabled: true },
): Promise<McpClientLike> {
  if (config.type === 'stdio') {
    return createMCPClient({
      transport: new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: buildStdioEnv(config.env),
      }),
    });
  }

  return createMCPClient({ transport: { type: 'http', url: config.url, headers: config.headers } });
}

function mergeTools(servers: StartedServer[], callTimeoutMs: number): Record<string, Tool> {
  const occurrences = new Map<string, number>();

  for (const { tools } of servers) {
    for (const name of Object.keys(tools)) {
      occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
    }
  }

  const merged: Record<string, Tool> = {};

  for (const { server, tools } of servers) {
    for (const [name, tool] of Object.entries(tools)) {
      const exposedName = (occurrences.get(name) ?? 0) > 1 ? `${server}__${name}` : name;

      merged[exposedName] = wrapTool(tool, callTimeoutMs);
    }
  }

  return merged;
}

function wrapTool(tool: Tool, callTimeoutMs: number): Tool {
  const execute = tool.execute;

  if (typeof execute !== 'function') {
    return tool;
  }

  return {
    ...tool,
    execute: async (input: unknown, options: ToolExecutionOptions<unknown>) => {
      const result = await withTimeout(Promise.resolve(execute(input, options)), callTimeoutMs);

      return normalizeMcpToolResult(result);
    },
  } as Tool;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`)), timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
