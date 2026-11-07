import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const label = process.env.FAKE_MCP_LABEL ?? 'fake';

const presentation = {
  version: 1,
  kind: 'information',
  headline: 'Structured',
  facts: [],
  warnings: [],
  nextActions: [],
};

const server = new Server(
  { name: 'fake-mcp-server', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: `Fake MCP server instructions for ${label}.`,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo text back.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    },
    {
      name: 'structured',
      description: 'Return text with structured content.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === 'echo') {
    return {
      content: [{ type: 'text', text: `echo:${args.text ?? ''}` }],
    };
  }

  if (name === 'structured') {
    return {
      content: [{ type: 'text', text: 'structured summary' }],
      structuredContent: {
        presentation,
        resourceUris: ['https://example.com/thing#it'],
      },
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
