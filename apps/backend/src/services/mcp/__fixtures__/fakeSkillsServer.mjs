import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ALPHA_BODY = 'ALPHA_SECRET_BODY_TEXT';
const ZETA_BODY = 'ZETA_SECRET_BODY_TEXT';

const skills = [
  {
    uri: 'https://pod.example/private/skills/zeta.ttl#zeta',
    name: 'Zeta',
    description: 'Zeta skill',
    activation: 'Use when zeta is needed',
    version: '1.0.0',
    body: ZETA_BODY,
    sourceUris: ['https://pod.example/private/skills/zeta.ttl'],
    workspace: 'https://pod.example/private/workspace/',
  },
  {
    uri: 'https://pod.example/private/skills/alpha.ttl#alpha',
    name: 'Alpha',
    description: 'Alpha skill',
    activation: 'Use when alpha is needed',
    version: '2.0.0',
    body: ALPHA_BODY,
    sourceUris: ['https://pod.example/private/skills/alpha.ttl'],
    workspace: 'https://pod.example/private/workspace/',
  },
];

const server = new Server({ name: 'fake-skills-server', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_skills',
      description: 'List available skills.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'list_skills') {
    return {
      content: [{ type: 'text', text: 'skills:2' }],
      structuredContent: { data: { skills } },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
