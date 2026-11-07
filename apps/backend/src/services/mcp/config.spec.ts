import { describe, expect, it } from 'vite-plus/test';

import { resolveMcpConfig, type McpConfig, type McpServerConfig } from './config';

function readerFor(config: unknown) {
  return () => JSON.stringify(config);
}

describe('resolveMcpConfig', () => {
  it('uses the default config', () => {
    const result = resolveMcpConfig({ env: {} });

    expect(result.enabled).toBe(true);
    expect(result.servers.cairn).toEqual({ type: 'stdio', command: 'cairn', args: ['mcp', 'stdio'], enabled: true });
    expect('env' in (result.servers.cairn ?? {})).toBe(false);
  });

  it('disables when ANIMA_MCP_ENABLED is false, even with a config file', () => {
    const result = resolveMcpConfig({
      env: { ANIMA_MCP_ENABLED: 'false', ANIMA_MCP_CONFIG: '/config/mcp.json' },
      readFile: () => {
        throw new Error('SKIP: disabled config must not be read');
      },
    });

    expect(result).toEqual({ enabled: false, servers: {} });
  });

  it('rejects invalid ANIMA_MCP_ENABLED values', () => {
    expect(() => resolveMcpConfig({ env: { ANIMA_MCP_ENABLED: 'maybe' } })).toThrow(/ANIMA_MCP_ENABLED/);
  });

  it('defaults to disabled in tests and re-enables with ANIMA_MCP_ENABLED=true', () => {
    expect(resolveMcpConfig({ env: { NODE_ENV: 'test' } })).toEqual({ enabled: false, servers: {} });

    const result = resolveMcpConfig({ env: { NODE_ENV: 'test', ANIMA_MCP_ENABLED: 'YES' } });

    expect(result.enabled).toBe(true);
    expect(Object.keys(result.servers)).toEqual(['cairn']);
  });

  it('defaults to disabled for E2E and EVALS runs', () => {
    expect(resolveMcpConfig({ env: { E2E: 'true' } }).enabled).toBe(false);
    expect(resolveMcpConfig({ env: { EVALS: 'true' } }).enabled).toBe(false);
  });

  it('reads a config file that replaces the default', () => {
    let receivedPath: string | undefined;
    const result = resolveMcpConfig({
      env: { ANIMA_MCP_CONFIG: '/config/mcp.json' },
      readFile: (path) => {
        receivedPath = path;

        return JSON.stringify({
          enabled: true,
          servers: {
            other: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } },
          },
        });
      },
    });

    expect(receivedPath).toBe('/config/mcp.json');
    expect(result.enabled).toBe(true);
    expect(result.servers.cairn).toBeUndefined();
    expect(result.servers.other).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      enabled: true,
    });
  });

  it('lets an explicit config file enabled value override the test default', () => {
    const result = resolveMcpConfig({
      env: { NODE_ENV: 'test', ANIMA_MCP_CONFIG: '/config/mcp.json' },
      readFile: readerFor({ enabled: true, servers: { cairn: { type: 'stdio', command: 'cairn' } } }),
    });

    expect(result.enabled).toBe(true);
    expect(Object.keys(result.servers)).toEqual(['cairn']);
  });

  it('selects servers from ANIMA_MCP_SERVERS and rejects unknown names', () => {
    const defaultConfig: McpConfig = {
      servers: {
        cairn: { type: 'stdio', command: 'cairn', args: ['mcp', 'stdio'] },
        other: { type: 'http', url: 'https://example.com/mcp' },
        unused: { type: 'stdio', command: 'unused' },
      },
    };

    const result = resolveMcpConfig({ env: { ANIMA_MCP_SERVERS: ' cairn , other ,' }, defaultConfig });

    expect(Object.keys(result.servers)).toEqual(['cairn', 'other']);
    expect(() => resolveMcpConfig({ env: { ANIMA_MCP_SERVERS: 'cairn,missing' }, defaultConfig })).toThrow(/missing/);
  });

  it('omits servers with enabled: false', () => {
    const result = resolveMcpConfig({
      env: {},
      defaultConfig: {
        servers: {
          cairn: { type: 'stdio', command: 'cairn', enabled: false },
          other: { type: 'stdio', command: 'other' },
        },
      },
    });

    expect(Object.keys(result.servers)).toEqual(['other']);
  });

  it('rejects invalid stdio and http servers', () => {
    const missingCommand = { broken: { type: 'stdio' } } as unknown as Record<string, McpServerConfig>;
    const relativeUrl = { broken: { type: 'http', url: '/mcp' } } as unknown as Record<string, McpServerConfig>;

    expect(() => resolveMcpConfig({ env: {}, defaultConfig: { servers: missingCommand } })).toThrow(/command/);
    expect(() => resolveMcpConfig({ env: {}, defaultConfig: { servers: relativeUrl } })).toThrow(/url/i);
  });

  it('reports malformed config files with their path', () => {
    expect(() =>
      resolveMcpConfig({ env: { ANIMA_MCP_CONFIG: '/config/broken.json' }, readFile: () => '{ not json' }),
    ).toThrow(/\/config\/broken\.json/);
  });

  it('returns no servers when the config is disabled', () => {
    const result = resolveMcpConfig({
      env: { ANIMA_MCP_CONFIG: '/config/mcp.json' },
      readFile: readerFor({ enabled: false, servers: { cairn: { type: 'stdio', command: 'cairn' } } }),
    });

    expect(result).toEqual({ enabled: false, servers: {} });
  });
});
