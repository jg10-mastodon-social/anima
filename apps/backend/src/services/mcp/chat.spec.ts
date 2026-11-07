import type { Tool } from 'ai';
import { describe, expect, it } from 'vite-plus/test';

import { composeMcpContext, composeSystemPrompt, mergeMcpTools } from './chat';
import { type CairnSkillSummary, composeSkillCatalog } from './skills';

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

describe('composeMcpContext', () => {
  const skills: CairnSkillSummary[] = [
    {
      uri: 'https://pod.example/private/skills/alpha.ttl#alpha',
      name: 'Alpha',
      description: 'Alpha skill.',
      activation: 'You need alpha.',
      version: '2.0.0',
    },
  ];

  it('returns trimmed instructions when there are no skills', () => {
    expect(composeMcpContext('  MCP instructions.  ', [])).toBe('MCP instructions.');
  });

  it('returns the skill catalogue when there are no instructions', () => {
    expect(composeMcpContext('   ', skills)).toBe(composeSkillCatalog(skills));
  });

  it('joins instructions and the catalogue with exactly two newlines', () => {
    expect(composeMcpContext('MCP instructions.', skills)).toBe(
      `MCP instructions.\n\n${composeSkillCatalog(skills)}`,
    );
  });

  it('returns an empty string when both parts are empty', () => {
    expect(composeMcpContext('', [])).toBe('');
    expect(composeMcpContext('  \n\t ', [])).toBe('');
  });

  it('includes names, descriptions, activations, and URIs but never bodies', () => {
    const text = composeMcpContext('MCP instructions.', [
      { ...skills[0]!, body: 'ALPHA_SECRET_BODY_TEXT' } as unknown as CairnSkillSummary,
    ]);

    expect(text).toContain('Alpha');
    expect(text).toContain('Alpha skill.');
    expect(text).toContain('You need alpha.');
    expect(text).toContain('https://pod.example/private/skills/alpha.ttl#alpha');
    expect(text).not.toContain('ALPHA_SECRET_BODY_TEXT');
    expect(text).not.toContain('body');
  });
});
