export interface NormalizedMcpToolResult {
  text: string;
  presentation?: unknown;
  resourceUris?: string[];
  isError?: boolean;
}

export function normalizeMcpToolResult(result: unknown): NormalizedMcpToolResult {
  const record = isRecord(result) ? result : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const structured = isRecord(record.structuredContent) ? record.structuredContent : undefined;

  const text = content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n\n');

  const normalized: NormalizedMcpToolResult = {
    text: text || (structured ? JSON.stringify(structured) : ''),
  };

  if (structured && 'presentation' in structured) {
    normalized.presentation = structured.presentation;
  }

  if (structured && Array.isArray(structured.resourceUris)) {
    const resourceUris = structured.resourceUris.filter((uri): uri is string => typeof uri === 'string');

    if (resourceUris.length === structured.resourceUris.length) {
      normalized.resourceUris = resourceUris;
    }
  }

  if (record.isError === true) {
    normalized.isError = true;
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
