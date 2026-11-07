import { auth } from '@anima/core';
import { jsonldToQuads, quadsToJsonLD, turtleToQuads } from '@noeldemartin/solid-utils';
import { tool } from 'ai';
import z from 'zod';

const DEFAULT_TEXT_LIMIT = 20_000;
const MAX_TEXT_LIMIT = 50_000;
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const ACCEPT = [
  'text/turtle',
  'application/ld+json;q=0.9',
  'text/markdown;q=0.8',
  'text/csv;q=0.8',
  'text/plain;q=0.7',
  '*/*;q=0.1',
].join(', ');

const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ttl: 'text/turtle',
  turtle: 'text/turtle',
  nt: 'application/n-triples',
  jsonld: 'application/ld+json',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  yml: 'application/yaml',
  yaml: 'application/yaml',
};

const RDF_CONTENT_TYPES = new Set(['text/turtle', 'application/n-triples']);
const TEXT_CONTENT_TYPES = new Set(['application/json', 'application/xml', 'application/yaml', 'application/x-yaml']);

type RdfFormat = 'turtle' | 'jsonld';

function fileName(url: string): string {
  const name = new URL(url).pathname.split('/').filter(Boolean).pop();

  if (!name) {
    return url;
  }

  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function resolveContentType(headers: Headers, url: string): string {
  const contentType = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();

  if (contentType && contentType !== 'application/octet-stream' && contentType !== 'binary/octet-stream') {
    return contentType;
  }

  const extension = new URL(url).pathname.split('.').pop()?.toLowerCase();

  return (extension && CONTENT_TYPES_BY_EXTENSION[extension]) || DEFAULT_CONTENT_TYPE;
}

function resolveRdfFormat(contentType: string, url: string): RdfFormat | null {
  if (contentType === 'application/ld+json') {
    return 'jsonld';
  }

  if (RDF_CONTENT_TYPES.has(contentType)) {
    return 'turtle';
  }

  const extension = new URL(url).pathname.split('.').pop()?.toLowerCase();

  if (extension === 'jsonld') {
    return 'jsonld';
  }

  if (extension === 'ttl' || extension === 'turtle' || extension === 'nt') {
    return 'turtle';
  }

  return null;
}

async function parseRdf(contents: string, format: RdfFormat, url: string) {
  const quads =
    format === 'jsonld'
      ? await jsonldToQuads(JSON.parse(contents), url)
      : await turtleToQuads(contents, { baseIRI: url });

  return quadsToJsonLD(quads);
}

function paginateText(contents: string, offset: number, limit: number) {
  const start = Math.min(offset, contents.length);
  let end = Math.min(start + limit, contents.length);

  if (end < contents.length) {
    const lastLineBreak = contents.lastIndexOf('\n', end);

    if (lastLineBreak > start) {
      end = lastLineBreak + 1;
    }

    const lastCodeUnit = contents.charCodeAt(end - 1);

    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end += 1;
    }
  }

  return { start, end, contents: contents.slice(start, end) };
}

function csvHeader(contents: string): string | null {
  const lineBreak = contents.indexOf('\n');

  return lineBreak === -1 ? null : contents.slice(0, lineBreak + 1);
}

export default tool({
  description: [
    "Read the contents of a file in the user's POD.",
    'RDF files are returned as JSON-LD.',
    'Markdown, CSV and plain text files are returned in pages; the result includes the file name, its total length and a nextOffset to continue reading with the offset argument.',
  ].join(' '),
  inputSchema: z.object({
    url: z.string().describe('The file url to read the contents of.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Character offset to start reading text files from. Omit to start from the beginning.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TEXT_LIMIT)
      .optional()
      .describe(`Maximum amount of characters to return from text files. Defaults to ${DEFAULT_TEXT_LIMIT}.`),
  }),
  outputSchema: z.any().describe('The contents of the file.'),
  async execute({ url, offset = 0, limit = DEFAULT_TEXT_LIMIT }) {
    const user = auth().getUser();
    const isInsideStorage = user.storageUrls.some((storageUrl) => url.startsWith(storageUrl));

    if (!isInsideStorage) {
      throw new Error("Cannot read files outside the user's POD");
    }

    const response = await auth().fetch(url, { headers: { Accept: ACCEPT } });

    if (!response.ok) {
      const status = response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;

      throw new Error(`Could not read file at ${url} (${status})`);
    }

    const contentType = resolveContentType(response.headers, url);
    const rdfFormat = resolveRdfFormat(contentType, url);

    if (rdfFormat) {
      return parseRdf(await response.text(), rdfFormat, url);
    }

    if (!contentType.startsWith('text/') && !TEXT_CONTENT_TYPES.has(contentType)) {
      throw new Error(`Unsupported file type "${contentType}" at ${url}. Only RDF and text files can be read.`);
    }

    const contents = (await response.text()).replace(/\r\n?/g, '\n');
    const page = paginateText(contents, offset, limit);
    const truncated = page.end < contents.length;
    const isCsv = contentType === 'text/csv' || new URL(url).pathname.toLowerCase().endsWith('.csv');
    const header = isCsv && page.start > 0 && page.contents.length > 0 ? csvHeader(contents) : null;

    return {
      file: {
        name: fileName(url),
        url,
        contentType,
        totalChars: contents.length,
      },
      offset: page.start,
      limit,
      truncated,
      nextOffset: truncated ? page.end : null,
      content: `${header ?? ''}${page.contents}`,
    };
  },
});
