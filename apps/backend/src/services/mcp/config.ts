import { readFileSync } from 'node:fs';

export type McpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean }
  | { type: 'http'; url: string; headers?: Record<string, string>; enabled?: boolean };

export interface McpConfig {
  enabled?: boolean;
  servers: Record<string, McpServerConfig>;
}

export interface ResolvedMcpConfig {
  enabled: boolean;
  servers: Record<string, McpServerConfig & { enabled: true }>;
}

export interface ResolveMcpConfigOptions {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  defaultConfig?: McpConfig;
}

const defaultMcpConfig: McpConfig = {
  enabled: true,
  servers: {
    cairn: { type: 'stdio', command: 'cairn', args: ['mcp', 'stdio'] },
  },
};

const trueValues = new Set(['true', '1', 'yes']);
const falseValues = new Set(['false', '0', 'no']);

export function resolveMcpConfig({
  env = process.env,
  readFile,
  defaultConfig,
}: ResolveMcpConfigOptions = {}): ResolvedMcpConfig {
  const explicit = parseEnabled(env.ANIMA_MCP_ENABLED);

  if (explicit === false) {
    return { enabled: false, servers: {} };
  }

  const configPath = env.ANIMA_MCP_CONFIG;
  const config = configPath ? readConfig(configPath, readFile ?? defaultReadFile) : (defaultConfig ?? defaultMcpConfig);
  const enabled = explicit ?? resolveDefaultEnabled(env, config, configPath !== undefined);

  if (!enabled) {
    return { enabled: false, servers: {} };
  }

  return { enabled: true, servers: selectServers(config.servers, env.ANIMA_MCP_SERVERS) };
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function readConfig(path: string, readFile: (path: string) => string): McpConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFile(path));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Failed to load MCP config file "${path}": ${message}`);
  }

  return validateConfig(parsed, path);
}

function validateConfig(value: unknown, path: string): McpConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid MCP config in "${path}": expected a JSON object.`);
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`Invalid MCP config in "${path}": "enabled" must be a boolean.`);
  }

  if (value.servers !== undefined && !isRecord(value.servers)) {
    throw new Error(`Invalid MCP config in "${path}": "servers" must be an object.`);
  }

  return {
    enabled: value.enabled,
    servers: (value.servers ?? {}) as Record<string, McpServerConfig>,
  };
}

function resolveDefaultEnabled(
  env: Record<string, string | undefined>,
  config: McpConfig,
  configFromFile: boolean,
): boolean {
  if (configFromFile && config.enabled !== undefined) {
    return config.enabled;
  }

  if (env.E2E === 'true' || env.EVALS === 'true' || env.NODE_ENV === 'test') {
    return false;
  }

  return config.enabled ?? true;
}

function parseEnabled(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (trueValues.has(normalized)) {
    return true;
  }

  if (falseValues.has(normalized)) {
    return false;
  }

  throw new Error(`Invalid ANIMA_MCP_ENABLED value "${value}": expected true/false, 1/0, or yes/no.`);
}

function selectServers(
  servers: Record<string, McpServerConfig>,
  allowlist: string | undefined,
): Record<string, McpServerConfig & { enabled: true }> {
  const selectedNames = parseAllowlist(allowlist);

  if (selectedNames) {
    const unknown = selectedNames.find((name) => !(name in servers));

    if (unknown !== undefined) {
      const known = Object.keys(servers).join(', ') || 'none';

      throw new Error(`Unknown MCP server "${unknown}": configured servers are ${known}.`);
    }
  }

  const selected: Record<string, McpServerConfig & { enabled: true }> = {};

  for (const [name, serverConfig] of Object.entries(servers)) {
    if (serverConfig.enabled === false) {
      continue;
    }

    if (selectedNames && !selectedNames.includes(name)) {
      continue;
    }

    selected[name] = { ...validateServer(name, serverConfig), enabled: true };
  }

  return selected;
}

function parseAllowlist(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  return names.length > 0 ? [...new Set(names)] : undefined;
}

function validateServer(name: string, value: unknown): McpServerConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid MCP server "${name}": expected an object.`);
  }

  const { type } = value;

  if (type !== 'stdio' && type !== 'http') {
    throw new Error(`Invalid MCP server "${name}": "type" must be "stdio" or "http".`);
  }

  const enabled = value.enabled;

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error(`Invalid MCP server "${name}": "enabled" must be a boolean.`);
  }

  if (type === 'stdio') {
    if (typeof value.command !== 'string' || value.command.trim() === '') {
      throw new Error(`Invalid MCP server "${name}": stdio servers require a non-empty "command".`);
    }

    if (
      value.args !== undefined &&
      (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string'))
    ) {
      throw new Error(`Invalid MCP server "${name}": "args" must be an array of strings.`);
    }

    if (value.env !== undefined) {
      validateStringRecord(name, 'env', value.env);
    }

    if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.trim() === '')) {
      throw new Error(`Invalid MCP server "${name}": "cwd" must be a non-empty string.`);
    }

    return {
      type,
      command: value.command,
      ...(value.args !== undefined ? { args: value.args as string[] } : {}),
      ...(value.env !== undefined ? { env: value.env as Record<string, string> } : {}),
      ...(value.cwd !== undefined ? { cwd: value.cwd as string } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
  }

  if (typeof value.url !== 'string' || !isAbsoluteHttpUrl(value.url)) {
    throw new Error(`Invalid MCP server "${name}": "url" must be an absolute http(s) URL.`);
  }

  if (value.headers !== undefined) {
    validateStringRecord(name, 'headers', value.headers);
  }

  return {
    type,
    url: value.url,
    ...(value.headers !== undefined ? { headers: value.headers as Record<string, string> } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

function validateStringRecord(serverName: string, field: string, value: unknown): void {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid MCP server "${serverName}": "${field}" must be a record of string values.`);
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);

    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
