// Sometimes a model gives up on the tool-calling API and writes its native tool-call syntax into the
// content channel instead. DeepSeek V4.x does this when it wants more tool work but no tools are
// available (for example on the last step of an agent loop, where `activeTools` is emptied), and the
// markup then reaches the user verbatim. These helpers read that markup and keep it out of chats.

export interface LeakedToolCall {
  name: string;
  input: Record<string, unknown>;
}

const PIPE = '\uFF5C';
const MARKER = /｜\s*DSML\s*｜/i;
const INVOKE_BLOCK = /<｜\s*DSML\s*｜\s*invoke\b[^>]*>[\s\S]*?(?:<\/｜\s*DSML\s*｜\s*invoke\s*>|$)/gi;
const DSML_TAG = /<\/?｜\s*DSML\s*｜[^>]*>/gi;
// Safety net for other fullwidth-pipe directives we don't know about yet: strip the tag rather than leak it.
const STRAY_TAG = /<\/?｜[^>]{0,500}?>/gi;
const INVOKE = /<｜\s*DSML\s*｜\s*invoke\b([^>]*)>([\s\S]*?)(?:<\/｜\s*DSML\s*｜\s*invoke\s*>|$)/gi;
const PARAMETER =
  /<｜\s*DSML\s*｜\s*parameter\b([^>]*)>([\s\S]*?)(?:<\/｜\s*DSML\s*｜\s*parameter\s*>|<｜\s*DSML\s*｜|$)/gi;
const MAX_LISTED = 3;

export function isToolCallMarkup(text: string): boolean {
  return MARKER.test(text);
}

export function parseToolCallMarkup(text: string): LeakedToolCall[] {
  const calls: LeakedToolCall[] = [];
  const invokes = new RegExp(INVOKE.source, INVOKE.flags);

  for (const invoke of text.matchAll(invokes)) {
    const name = attribute(invoke[1] ?? '', 'name');
    const input: Record<string, unknown> = {};

    for (const parameter of (invoke[2] ?? '').matchAll(new RegExp(PARAMETER.source, PARAMETER.flags))) {
      const key = attribute(parameter[1] ?? '', 'name');

      if (key) {
        input[key] = stripTags(parameter[2] ?? '').trim();
      }
    }

    if (name) {
      calls.push({ name, input });
    }
  }

  return calls;
}

export function stripToolCallMarkup(text: string): string {
  return stripTags(text)
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Assistant text is sanitized on storage and on render: markup is never shown, and when nothing else was
// written we say what the model was trying to do instead of leaving an empty bubble.
export function sanitizeAssistantText(text: string): string {
  if (!text.includes(PIPE)) {
    return text;
  }

  const stripped = stripToolCallMarkup(text);

  if (stripped !== '') {
    return stripped;
  }

  if (text.trim() === '') {
    return text;
  }

  // Everything written was markup: say what the model was trying to do instead of sending an empty bubble.
  return budgetNotice(parseToolCallMarkup(text));
}

function budgetNotice(calls: readonly LeakedToolCall[]): string {
  const notice = 'I ran out of tool budget before I could finish that.';
  const urls = unique(
    calls
      .map((call) => call.input.url)
      .filter((url): url is string => typeof url === 'string' && url.trim() !== '')
      .map((url) => url.trim()),
  );

  if (urls.length > 0) {
    return `${notice} I was about to read ${formatList(urls)}. Ask me again and I'll continue.`;
  }

  const names = unique(calls.map((call) => call.name));

  if (names.length > 0) {
    return `${notice} I was about to use ${formatList(names)}. Ask me again and I'll continue.`;
  }

  return `${notice} Ask me again and I'll continue.`;
}

function stripTags(text: string): string {
  const stripped = text
    .replace(new RegExp(INVOKE_BLOCK.source, INVOKE_BLOCK.flags), '')
    .replace(new RegExp(DSML_TAG.source, DSML_TAG.flags), '')
    .replace(new RegExp(STRAY_TAG.source, STRAY_TAG.flags), '');

  return dropUnclosedTag(stripped);
}

// While a response is streaming, a half-written tag would otherwise flash in the UI: hold back the tail from
// the last opener that has no closing bracket yet.
function dropUnclosedTag(text: string): string {
  const opener = text.lastIndexOf(`<${PIPE}`);

  if (opener === -1 || text.indexOf('>', opener) !== -1) {
    return text;
  }

  return text.slice(0, opener);
}

function attribute(attributes: string, name: string): string | null {
  const matched = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes);

  return matched ? (matched[1] ?? matched[2] ?? '').trim() : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function formatList(values: readonly string[]): string {
  const listed = values.slice(0, MAX_LISTED);
  const remaining = values.length - listed.length;
  const last = remaining > 0 ? `and ${remaining} more` : null;
  const items = last ? [...listed, last] : listed;

  if (items.length === 1) {
    return items[0] ?? '';
  }

  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
