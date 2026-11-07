import type { Tool } from 'ai';
import { describe, expect, it } from 'vite-plus/test';

import { composeSystemPrompt, mergeMcpTools } from './chat';

function tool(description: string): Tool {
  return { description } as unknown as Tool;
}

describe('mergeMcpTools', () => {
  it('keeps every core and MCP tool, including read-only and write-style tools', () => {
    const coreTools = {
      find_things: tool('Find things.'),
      read_user_thing: tool('Read a user thing.'),
      apply_change: tool('Apply a reviewed change.'),
      store_skill: tool('Store a skill.'),
    };
    const mcpTools = {
      search_user_things: tool('Search user data.'),
      propose_user_thing_change: tool('Propose a user thing change.'),
      inspect_user_thing: tool('Inspect a user thing.'),
    };

    const merged = mergeMcpTools(coreTools, mcpTools);

    expect(Object.keys(merged).sort()).toEqual([
      'apply_change',
      'find_things',
      'inspect_user_thing',
      'propose_user_thing_change',
      'read_user_thing',
      'search_user_things',
      'store_skill',
    ]);

    for (const [name, coreTool] of Object.entries(coreTools)) {
      expect(merged[name]).toBe(coreTool);
    }

    for (const [name, mcpTool] of Object.entries(mcpTools)) {
      expect(merged[name]).toBe(mcpTool);
    }
  });

  it('lets the MCP tool win when a name collides', () => {
    const coreTool = tool('Core tool.');
    const mcpTool = tool('MCP tool.');

    const merged = mergeMcpTools({ apply_change: coreTool }, { apply_change: mcpTool });

    // MCP tools are spread last on purpose: a server that exposes a core tool name overrides it.
    expect(merged.apply_change).toBe(mcpTool);
    expect(Object.keys(merged)).toEqual(['apply_change']);
  });

  it('returns a new object without mutating the inputs', () => {
    const coreTools = { find_things: tool('Find things.') };
    const mcpTools = { search_user_things: tool('Search user things.') };

    const merged = mergeMcpTools(coreTools, mcpTools);

    expect(merged).not.toBe(coreTools);
    expect(coreTools).not.toHaveProperty('search_user_things');
    expect(mcpTools).not.toHaveProperty('find_things');
  });
});

describe('composeSystemPrompt', () => {
  it('appends trimmed instructions after exactly two newlines', () => {
    expect(composeSystemPrompt('Base prompt.', '\n  MCP instructions.  \n')).toBe('Base prompt.\n\nMCP instructions.');
  });

  it('returns the base prompt unchanged when instructions are empty or whitespace-only', () => {
    expect(composeSystemPrompt('Base prompt.', '')).toBe('Base prompt.');
    expect(composeSystemPrompt('Base prompt.', '   \n\t ')).toBe('Base prompt.');
  });
});
