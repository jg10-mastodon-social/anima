import { describe, expect, it, vi } from 'vite-plus/test';

import type { ResolvedMcpConfig } from './config';
import { closeMcpServers, initializeMcpServers } from './index';
import type { McpServerDiagnostic } from './McpService';

const enabledConfig: ResolvedMcpConfig = {
  enabled: true,
  servers: {
    cairn: { type: 'stdio', command: 'cairn', args: ['mcp', 'stdio'], enabled: true },
  },
};

function createService(diagnostics: McpServerDiagnostic[] = []) {
  return {
    start: vi.fn(async (_config: ResolvedMcpConfig) => {}),
    getDiagnostics: vi.fn(() => diagnostics),
  };
}

function createLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

describe('initializeMcpServers', () => {
  it('does nothing when the config is disabled', async () => {
    const service = createService();
    const logger = createLogger();

    await initializeMcpServers({
      service,
      resolveConfig: () => ({ enabled: false, servers: {} }),
      logger,
    });

    expect(service.start).not.toHaveBeenCalled();
    expect(service.getDiagnostics).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and continues when config resolution throws', async () => {
    const service = createService();
    const logger = createLogger();

    await expect(
      initializeMcpServers({
        service,
        resolveConfig: () => {
          throw new Error('broken config');
        },
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(service.start).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('broken config'));
  });

  it('warns and continues when the service fails to start', async () => {
    const service = createService();
    const logger = createLogger();

    service.start.mockRejectedValue(new Error('server start failed'));

    await expect(
      initializeMcpServers({ service, resolveConfig: () => enabledConfig, logger }),
    ).resolves.toBeUndefined();

    expect(service.start).toHaveBeenCalledWith(enabledConfig);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('server start failed'));
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs started diagnostics with log and failed diagnostics with warn', async () => {
    const service = createService([
      { server: 'cairn', status: 'started', toolCount: 3 },
      { server: 'broken', status: 'failed', error: 'spawn failed' },
    ]);
    const logger = createLogger();

    await initializeMcpServers({ service, resolveConfig: () => enabledConfig, logger });

    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith('MCP server "cairn" started with 3 tools.');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"broken"'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('spawn failed'));
  });

  it('passes the resolved config to the service', async () => {
    const service = createService();
    const logger = createLogger();

    await initializeMcpServers({ service, resolveConfig: () => enabledConfig, logger });

    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledWith(enabledConfig);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('closeMcpServers', () => {
  it('delegates to the provided service close', async () => {
    const close = vi.fn(async () => {});

    await closeMcpServers({ close });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('propagates close failures to the caller', async () => {
    const close = vi.fn(async () => {
      throw new Error('close failed');
    });

    await expect(closeMcpServers({ close })).rejects.toThrow('close failed');
  });
});
