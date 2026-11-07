import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { resolveMcpConfig } from './config';

describe('mcp.example.json', () => {
  it('loads the documented example config', () => {
    const contents = readFileSync(join(import.meta.dirname, '../../../mcp.example.json'), 'utf8');

    const result = resolveMcpConfig({
      env: { ANIMA_MCP_CONFIG: 'mcp.example.json' },
      readFile: () => contents,
    });

    expect(result.enabled).toBe(true);
    expect(Object.keys(result.servers)).toEqual(['cairn']);
    expect(result.servers.cairn).toEqual({
      type: 'stdio',
      command: 'cairn',
      args: ['mcp', 'stdio'],
      enabled: true,
    });
  });
});
