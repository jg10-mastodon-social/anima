import { describe, expect, it } from 'vite-plus/test';

import { isToolCallMarkup, parseToolCallMarkup, sanitizeAssistantText } from './tool-call-markup';

// The leaked markup uses fullwidth pipes; building it here keeps the literal sequence out of the source.
const PIPE = '\uFF5C';
const markup = (source: string): string => source.replaceAll('|', PIPE);

const pantryCalls = markup(
  `
<|DSML| calls>
<|DSML| invoke name="readFileContents">
<|DSML| parameter name="url" string="true">https://pod.example/private/twin/totterdell99/pantry/pantry.ttl</|DSML| parameter>
</|DSML| invoke>
<|DSML| invoke name="readFileContents">
<|DSML| parameter name="url" string="true">https://pod.example/private/twin/totterdell99/pantry/recipe-index.ttl</|DSML| parameter>
</|DSML| invoke>
</|DSML| calls>
`,
).trim();

const listingCall = markup(`
<|DSML| calls>
<|DSML| invoke name="listContainerFiles">
<|DSML| parameter name="url" string="true">https://pod.example/private/cookbook/</|DSML| parameter>
</|DSML| invoke>
</|DSML| calls>
`).trim();

describe('isToolCallMarkup', () => {
  it('detects leaked tool-call markup', () => {
    expect(isToolCallMarkup(pantryCalls)).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(isToolCallMarkup('I read both files for you.')).toBe(false);
  });
});

describe('parseToolCallMarkup', () => {
  it('reads the tool name and parameters of every invoke block', () => {
    expect(parseToolCallMarkup(pantryCalls)).toEqual([
      { name: 'readFileContents', input: { url: 'https://pod.example/private/twin/totterdell99/pantry/pantry.ttl' } },
      {
        name: 'readFileContents',
        input: { url: 'https://pod.example/private/twin/totterdell99/pantry/recipe-index.ttl' },
      },
    ]);
  });

  it('returns nothing for ordinary text', () => {
    expect(parseToolCallMarkup('Nothing to see here.')).toEqual([]);
  });
});

describe('sanitizeAssistantText', () => {
  it('returns text without markup untouched', () => {
    expect(sanitizeAssistantText('I read both files for you.')).toBe('I read both files for you.');
  });

  it('never leaves tool-call syntax behind', () => {
    const sanitized = sanitizeAssistantText(pantryCalls);

    expect(sanitized).not.toContain('DSML');
    expect(sanitized).not.toContain('<');
    expect(sanitized).toContain('https://pod.example/private/twin/totterdell99/pantry/pantry.ttl');
  });

  it('keeps the prose that came before the markup', () => {
    const text = `I'll start by discovering where your pantry and recipes live.\n\n${pantryCalls}`;

    expect(sanitizeAssistantText(text)).toBe("I'll start by discovering where your pantry and recipes live.");
  });

  it('explains what it was about to read when nothing else was written', () => {
    expect(sanitizeAssistantText(pantryCalls)).toBe(
      'I ran out of tool budget before I could finish that. I was about to read ' +
        'https://pod.example/private/twin/totterdell99/pantry/pantry.ttl and ' +
        "https://pod.example/private/twin/totterdell99/pantry/recipe-index.ttl. Ask me again and I'll continue.",
    );
  });

  it('names the tool when there is no file url to report', () => {
    expect(sanitizeAssistantText(listingCall)).toContain('I was about to read https://pod.example/private/cookbook/');
  });

  it('falls back to a generic notice when the markup cannot be read', () => {
    const text = markup('<|DSML| calls>\n<|DSML| invoke>');

    expect(sanitizeAssistantText(text)).toBe(
      "I ran out of tool budget before I could finish that. Ask me again and I'll continue.",
    );
  });

  it('holds back a tag that is still streaming', () => {
    expect(sanitizeAssistantText(markup('Reading it now. <|DSML| invoke name="readFileContents"'))).toBe(
      'Reading it now.',
    );
    expect(sanitizeAssistantText(markup('Reading it now. <|'))).toBe('Reading it now.');
  });

  it('strips unknown fullwidth-pipe directives rather than leaking them', () => {
    expect(sanitizeAssistantText(markup('Done. <|TOOL| run something>'))).toBe('Done.');
  });
});
