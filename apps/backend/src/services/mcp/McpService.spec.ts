import { join } from 'node:path';

import type { Tool, ToolExecutionOptions } from 'ai';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import type { McpServerConfig, ResolvedMcpConfig } from './config';
import {
  buildStdioEnv,
  McpService,
  type McpClientLike,
  type McpServerDiagnostic,
  type McpServiceOptions,
} from './McpService';
import { normalizeMcpToolResult } from './normalize';

const fixturePath = join(import.meta.dirname, '__fixtures__', 'fakeMcpServer.mjs');
const silentLogger = { warn: () => {}, info: () => {} };
const STDIO_TIMEOUT_MS = 30_000;
const callOptions: ToolExecutionOptions<unknown> = { toolCallId: 'test-call', messages: [], context: {} };

type EnabledServer = McpServerConfig & { enabled: true };

const runningServices: McpService[] = [];

function createService(options: McpServiceOptions = {}): McpService {
  const service = new McpService({ logger: silentLogger, ...options });

  runningServices.push(service);

  return service;
}

function stdioServer(env?: Record<string, string>): EnabledServer {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [fixturePath],
    ...(env ? { env } : {}),
    enabled: true,
  };
}

function enabledConfig(servers: Record<string, EnabledServer>): ResolvedMcpConfig {
  return { enabled: true, servers };
}

function fakeClient(tools: Record<string, Tool>, instructions?: string): McpClientLike {
  return {
    instructions,
    tools: async () => tools,
    close: async () => {},
  };
}

async function executeTool(tool: Tool | undefined, input: unknown): Promise<unknown> {
  if (!tool?.execute) {
    throw new Error('Tool is not executable');
  }

  return tool.execute(input, callOptions);
}

function diagnosticsFor(service: McpService, server: string): McpServerDiagnostic | undefined {
  return service.getDiagnostics().find((diagnostic) => diagnostic.server === server);
}

afterEach(async () => {
  await Promise.all(runningServices.splice(0).map((service) => service.close()));
});

describe('normalizeMcpToolResult', () => {
  it('joins text parts and preserves presentation and resource URIs', () => {
    const result = normalizeMcpToolResult({
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: 'image-data', mimeType: 'image/png' },
        { type: 'text', text: 'second' },
      ],
      structuredContent: {
        presentation: { version: 1, kind: 'information' },
        resourceUris: ['https://example.com/thing#it'],
      },
    });

    expect(result).toEqual({
      text: 'first\n\nsecond',
      presentation: { version: 1, kind: 'information' },
      resourceUris: ['https://example.com/thing#it'],
    });
    expect(result).not.toHaveProperty('content');
    expect(result).not.toHaveProperty('isError');
  });

  it('preserves isError only when it is true', () => {
    expect(normalizeMcpToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true })).toEqual({
      text: 'boom',
      isError: true,
    });
    expect(normalizeMcpToolResult({ content: [{ type: 'text', text: 'fine' }], isError: false })).toEqual({
      text: 'fine',
    });
  });

  it('falls back to JSON for structured content without text', () => {
    expect(normalizeMcpToolResult({ structuredContent: { answer: 42 } })).toEqual({ text: '{"answer":42}' });
  });

  it('ignores malformed content and resource URIs', () => {
    expect(normalizeMcpToolResult({ content: 'not-an-array' })).toEqual({ text: '' });
    expect(
      normalizeMcpToolResult({ structuredContent: { resourceUris: ['https://example.com', 42] }, isError: 'yes' }),
    ).toEqual({ text: '{"resourceUris":["https://example.com",42]}' });
  });
});

describe('McpService', () => {
  it('starts a real stdio server and exposes its tools', async () => {
    const service = createService();

    await service.start(enabledConfig({ one: stdioServer({ FAKE_MCP_LABEL: 'one' }) }));

    const tools = service.getTools();

    expect(Object.keys(tools).sort()).toEqual(['echo', 'structured']);
    expect(service.getInstructions()).toContain('one');
    expect(service.getDiagnostics()).toEqual([{ server: 'one', status: 'started', toolCount: 2 }]);

    expect(await executeTool(tools.echo, { text: 'hi' })).toEqual({ text: 'echo:hi' });
    expect(await executeTool(tools.structured, {})).toEqual({
      text: 'structured summary',
      presentation: {
        version: 1,
        kind: 'information',
        headline: 'Structured',
        facts: [],
        warnings: [],
        nextActions: [],
      },
      resourceUris: ['https://example.com/thing#it'],
    });

    service.getDiagnostics().pop();
    expect(service.getDiagnostics()).toEqual([{ server: 'one', status: 'started', toolCount: 2 }]);

    await service.start(enabledConfig({ two: stdioServer({ FAKE_MCP_LABEL: 'two' }) }));

    expect(Object.keys(service.getTools()).sort()).toEqual(['echo', 'structured']);
    expect(service.getInstructions()).toContain('one');
    expect(service.getInstructions()).not.toContain('two');
    expect(service.getDiagnostics()).toEqual([{ server: 'one', status: 'started', toolCount: 2 }]);
  }, STDIO_TIMEOUT_MS);

  it('prefixes colliding tool names with the server name', async () => {
    const service = createService();

    await service.start(
      enabledConfig({
        one: stdioServer({ FAKE_MCP_LABEL: 'one' }),
        two: stdioServer({ FAKE_MCP_LABEL: 'two' }),
      }),
    );

    const tools = service.getTools();

    expect(Object.keys(tools).sort()).toEqual(['one__echo', 'one__structured', 'two__echo', 'two__structured']);
    expect(tools.echo).toBeUndefined();

    expect(await executeTool(tools.one__echo, { text: 'hi' })).toEqual({ text: 'echo:hi' });
    expect(await executeTool(tools.two__echo, { text: 'yo' })).toEqual({ text: 'echo:yo' });

    const instructions = service.getInstructions();

    expect(instructions).toContain('MCP server "one" instructions:');
    expect(instructions).toContain('MCP server "two" instructions:');
    expect(instructions.split('\n\n')).toHaveLength(2);
  }, STDIO_TIMEOUT_MS);

  it('keeps starting other servers when one fails', async () => {
    const service = createService();

    await service.start(
      enabledConfig({
        good: stdioServer({ FAKE_MCP_LABEL: 'good' }),
        bad: { type: 'stdio', command: 'definitely-not-a-real-mcp-command', enabled: true },
      }),
    );

    expect(Object.keys(service.getTools()).sort()).toEqual(['echo', 'structured']);
    expect(diagnosticsFor(service, 'good')).toEqual({ server: 'good', status: 'started', toolCount: 2 });
    expect(diagnosticsFor(service, 'bad')).toEqual({
      server: 'bad',
      status: 'failed',
      error: expect.any(String),
    });
  }, STDIO_TIMEOUT_MS);

  it('does nothing when disabled or unconfigured', async () => {
    const disabled = createService();

    await disabled.start({ enabled: false, servers: {} });

    expect(disabled.getTools()).toEqual({});
    expect(disabled.getInstructions()).toBe('');
    expect(disabled.getDiagnostics()).toEqual([]);

    const unconfigured = createService();

    await unconfigured.start({ enabled: true, servers: {} });

    expect(unconfigured.getTools()).toEqual({});
    expect(unconfigured.getInstructions()).toBe('');
    expect(unconfigured.getDiagnostics()).toEqual([]);
  });

  it('clears state on close and allows starting again', async () => {
    const service = createService();
    const config = enabledConfig({ one: stdioServer({ FAKE_MCP_LABEL: 'one' }) });

    await service.start(config);

    expect(Object.keys(service.getTools())).not.toHaveLength(0);

    await service.close();

    expect(service.getTools()).toEqual({});
    expect(service.getInstructions()).toBe('');
    expect(service.getDiagnostics()).toEqual([]);

    await service.start(config);

    expect(Object.keys(service.getTools()).sort()).toEqual(['echo', 'structured']);
    expect(service.getDiagnostics()).toEqual([{ server: 'one', status: 'started', toolCount: 2 }]);
  }, STDIO_TIMEOUT_MS);

  it('keeps tools without an execute function unchanged', async () => {
    const passiveTool = { description: 'Passive.', inputSchema: {} } as unknown as Tool;
    const service = createService({ createClient: async () => fakeClient({ passive: passiveTool }) });

    await service.start(enabledConfig({ passive: stdioServer() }));

    expect(service.getTools().passive).toBe(passiveTool);
  });

  it('rejects tool calls that exceed the timeout', async () => {
    const hangingTool = {
      description: 'Never resolves.',
      inputSchema: {},
      execute: () => new Promise<never>(() => {}),
    } as unknown as Tool;

    const service = createService({
      callTimeoutMs: 10,
      createClient: async () => fakeClient({ slow: hangingTool }),
    });

    await service.start(enabledConfig({ slow: stdioServer() }));

    const startedAt = Date.now();

    await expect(executeTool(service.getTools().slow, {})).rejects.toThrow(/timed out after 10ms/);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('buildStdioEnv', () => {
  it('copies only the safe environment and merges extras', () => {
    const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LC_CUSTOM_TEST', 'XDG_CUSTOM_TEST'] as const;
    const previous = keys.map((key) => process.env[key]);

    try {
      process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
      process.env.OPENAI_API_KEY = 'openai-secret';
      process.env.LC_CUSTOM_TEST = 'custom-locale';
      process.env.XDG_CUSTOM_TEST = 'custom-xdg';

      const env = buildStdioEnv({ FAKE_MCP_LABEL: 'extra' });

      expect(env.HOME).toBe(process.env.HOME);
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.FAKE_MCP_LABEL).toBe('extra');
      expect(env.LC_CUSTOM_TEST).toBe('custom-locale');
      expect(env.XDG_CUSTOM_TEST).toBe('custom-xdg');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      for (const [index, key] of keys.entries()) {
        if (previous[index] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[index];
        }
      }
    }
  });
});
