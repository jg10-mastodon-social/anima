import type { Tool } from 'ai';

// Every core and MCP tool is exposed to the model: there is no allowlist or filtering. MCP tools are spread last
// on purpose, so an MCP tool wins if it shares a name with a core tool.
export function mergeMcpTools(coreTools: Record<string, Tool>, mcpTools: Record<string, Tool>): Record<string, Tool> {
  return { ...coreTools, ...mcpTools };
}

export function composeSystemPrompt(base: string, mcpInstructions: string): string {
  const instructions = mcpInstructions.trim();

  if (instructions === '') {
    return base;
  }

  return `${base}\n\n${instructions}`;
}
