import type { Tool } from 'ai';

import type { CairnSkillSummary } from './skills';
import { composeSkillCatalog } from './skills';

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

// The catalogue carries names, descriptions, activations, and URIs only; skill bodies are fetched on demand with
// load_skill.
export function composeMcpContext(instructions: string, skills: readonly CairnSkillSummary[]): string {
  return [instructions.trim(), composeSkillCatalog(skills)].filter((part) => part !== '').join('\n\n');
}
