import { resolveMcpConfig, type ResolvedMcpConfig } from './config';
import { McpService } from './McpService';
import { SkillCatalog } from './skills';

export const mcpService = new McpService();
export const skillCatalog = new SkillCatalog({ service: mcpService });

export interface InitializeMcpOptions {
  service?: Pick<McpService, 'start' | 'getDiagnostics'>;
  resolveConfig?: () => ResolvedMcpConfig;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export async function initializeMcpServers(options: InitializeMcpOptions = {}): Promise<void> {
  const service = options.service ?? mcpService;
  const resolveConfig = options.resolveConfig ?? resolveMcpConfig;
  const logger = options.logger ?? console;

  let config: ResolvedMcpConfig;

  try {
    config = resolveConfig();
  } catch (error) {
    logger.warn(`Failed to resolve MCP config: ${errorMessage(error)}`);

    return;
  }

  if (!config.enabled) {
    return;
  }

  try {
    await service.start(config);
  } catch (error) {
    logger.warn(`Failed to start MCP servers: ${errorMessage(error)}`);

    return;
  }

  for (const diagnostic of service.getDiagnostics()) {
    if (diagnostic.status === 'started') {
      logger.log(`MCP server "${diagnostic.server}" started with ${diagnostic.toolCount} tools.`);

      continue;
    }

    logger.warn(`MCP server "${diagnostic.server}" failed to start: ${diagnostic.error}`);
  }
}

export async function closeMcpServers(service: Pick<McpService, 'close'> = mcpService): Promise<void> {
  await service.close();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
