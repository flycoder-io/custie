import { marked, type Token, type Tokens } from 'marked';

// Slack Block Kit rich_text element types
type Style = { bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean };

type InlineText = { type: 'text'; text: string; style?: Style };
type InlineLink = { type: 'link'; url: string; text?: string; style?: Style };
type Inline = InlineText | InlineLink;

type Section = { type: 'rich_text_section'; elements: Inline[] };
type List = {
  type: 'rich_text_list';
  style: 'bullet' | 'ordered';
  indent: number;
  elements: Section[];
};
type Preformatted = { type: 'rich_text_preformatted'; elements: InlineText[] };
type Quote = { type: 'rich_text_quote'; elements: Inline[] };

type RichElement = Section | List | Preformatted | Quote;

export type RichTextBlock = { type: 'rich_text'; elements: RichElement[] };

// Per-message budget for inline text. Slack messages cap around 40k chars and
// each rich_text block softly caps a few thousand — 2900 leaves room for headers.
const MESSAGE_TEXT_BUDGET = 2900;

export function markdownToBlocks(md: string): RichTextBlock[] {
  const tokens = marked.lexer(md);
  const elements: RichElement[] = [];
  for (const token of tokens) walkBlock(token, elements);
  if (elements.length === 0) return [];
  return chunkElements(elements);
}

function chunkElements(elements: RichElement[]): RichTextBlock[] {
  const blocks: RichTextBlock[] = [];
  let current: RichElement[] = [];
  let currentSize = 0;

  const flush = () => {
    if (current.length > 0) {
      blocks.push({ type: 'rich_text', elements: current });
      current = [];
      currentSize = 0;
    }
  };

  for (const el of elements) {
    const size = elementSize(el);
    if (size > MESSAGE_TEXT_BUDGET) {
      flush();
      for (const piece of splitElement(el, MESSAGE_TEXT_BUDGET)) {
        blocks.push({ type: 'rich_text', elements: [piece] });
      }
      continue;
    }
    if (currentSize + size > MESSAGE_TEXT_BUDGET) flush();
    current.push(el);
    currentSize += size;
  }
  flush();
  return blocks;
}

function elementSize(el: RichElement): number {
  switch (el.type) {
    case 'rich_text_section':
    case 'rich_text_quote':
      return inlineSize(el.elements);
    case 'rich_text_preformatted':
      return inlineSize(el.elements);
    case 'rich_text_list':
      return el.elements.reduce((sum, sec) => sum + inlineSize(sec.elements), 0);
  }
}

function inlineSize(els: Inline[]): number {
  return els.reduce((sum, el) => sum + (el.type === 'text' ? el.text.length : (el.text || el.url).length), 0);
}

function splitElement(el: RichElement, budget: number): RichElement[] {
  if (el.type === 'rich_text_list') {
    const out: List[] = [];
    let bucket: Section[] = [];
    let size = 0;
    for (const sec of el.elements) {
      const s = inlineSize(sec.elements);
      if (size + s > budget && bucket.length > 0) {
        out.push({ type: 'rich_text_list', style: el.style, indent: el.indent, elements: bucket });
        bucket = [];
        size = 0;
      }
      bucket.push(sec);
      size += s;
    }
    if (bucket.length > 0) {
      out.push({ type: 'rich_text_list', style: el.style, indent: el.indent, elements: bucket });
    }
    return out;
  }
  if (el.type === 'rich_text_preformatted') {
    const text = el.elements.map((e) => e.text).join('');
    const pieces: Preformatted[] = [];
    for (let i = 0; i < text.length; i += budget) {
      pieces.push({
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text: text.slice(i, i + budget) }],
      });
    }
    return pieces;
  }
  // Sections & quotes: split inline elements at text boundaries.
  const inlines = el.type === 'rich_text_section' ? el.elements : el.elements;
  const groups = splitInlines(inlines, budget);
  return groups.map((g) => ({ ...el, elements: g } as RichElement));
}

function splitInlines(els: Inline[], budget: number): Inline[][] {
  const out: Inline[][] = [];
  let cur: Inline[] = [];
  let size = 0;
  for (const el of els) {
    const len = el.type === 'text' ? el.text.length : (el.text || el.url).length;
    if (size + len > budget && cur.length > 0) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    if (len > budget && el.type === 'text') {
      // Hard split a long text node
      let remaining = el.text;
      while (remaining.length > budget) {
        cur.push({ ...el, text: remaining.slice(0, budget) });
        out.push(cur);
        cur = [];
        size = 0;
        remaining = remaining.slice(budget);
      }
      if (remaining) {
        cur.push({ ...el, text: remaining });
        size += remaining.length;
      }
    } else {
      cur.push(el);
      size += len;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function walkBlock(token: Token, out: RichElement[]): void {
  switch (token.type) {
    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      out.push({ type: 'rich_text_section', elements: convertInline(t.tokens) });
      break;
    }
    case 'heading': {
      // Slack rich_text has no heading element. Bold the inline content as a section.
      const t = token as Tokens.Heading;
      const inline = convertInline(t.tokens).map(boldify);
      out.push({ type: 'rich_text_section', elements: inline });
      break;
    }
    case 'list': {
      walkList(token as Tokens.List, 0, out);
      break;
    }
    case 'code': {
      const t = token as Tokens.Code;
      out.push({
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text: t.text }],
      });
      break;
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      const inline: Inline[] = [];
      for (const sub of t.tokens) {
        const subInline = inlineFromBlockToken(sub);
        if (inline.length > 0 && subInline.length > 0) inline.push({ type: 'text', text: '\n' });
        inline.push(...subInline);
      }
      out.push({ type: 'rich_text_quote', elements: inline });
      break;
    }
    case 'space':
    case 'hr':
      break;
    case 'html': {
      const t = token as Tokens.HTML;
      out.push({ type: 'rich_text_section', elements: [{ type: 'text', text: t.text }] });
      break;
    }
    case 'table': {
      // No native table support in rich_text. Render as monospace ASCII table.
      const t = token as Tokens.Table;
      const ascii = renderAsciiTable(t);
      out.push({ type: 'rich_text_preformatted', elements: [{ type: 'text', text: ascii }] });
      break;
    }
    default: {
      const t = token as { text?: string; raw?: string };
      const fallback = t.text ?? t.raw ?? '';
      if (fallback) {
        out.push({ type: 'rich_text_section', elements: [{ type: 'text', text: fallback }] });
      }
    }
  }
}

function walkList(list: Tokens.List, indent: number, out: RichElement[]): void {
  const style: 'bullet' | 'ordered' = list.ordered ? 'ordered' : 'bullet';
  let pending: Section[] = [];
  const flush = () => {
    if (pending.length > 0) {
      out.push({ type: 'rich_text_list', style, indent, elements: pending });
      pending = [];
    }
  };

  for (const item of list.items) {
    const inline: Inline[] = [];
    const trailing: Array<{ kind: 'list'; node: Tokens.List } | { kind: 'block'; node: Token }> = [];

    for (const sub of item.tokens) {
      if (sub.type === 'list') {
        trailing.push({ kind: 'list', node: sub as Tokens.List });
      } else if (sub.type === 'code' || sub.type === 'blockquote') {
        // Block-level content not allowed inside rich_text_list items — emit after current list.
        trailing.push({ kind: 'block', node: sub });
      } else if (sub.type === 'text' || sub.type === 'paragraph') {
        const subTokens = (sub as Tokens.Paragraph | Tokens.Text).tokens || [];
        if (inline.length > 0) inline.push({ type: 'text', text: '\n' });
        inline.push(...convertInline(subTokens));
      } else if (sub.type === 'space') {
        // skip
      } else {
        // Best effort
        const subTokens = (sub as { tokens?: Token[] }).tokens;
        if (subTokens) {
          if (inline.length > 0) inline.push({ type: 'text', text: '\n' });
          inline.push(...convertInline(subTokens));
        }
      }
    }

    pending.push({
      type: 'rich_text_section',
      elements: inline.length > 0 ? mergeAdjacentText(inline) : [{ type: 'text', text: '' }],
    });

    for (const t of trailing) {
      flush();
      if (t.kind === 'list') walkList(t.node, indent + 1, out);
      else walkBlock(t.node, out);
    }
  }

  flush();
}

function convertInline(tokens: Token[]): Inline[] {
  const out: Inline[] = [];
  for (const t of tokens) emitInline(t, {}, out);
  return mergeAdjacentText(out);
}

function emitInline(token: Token, style: Style, out: Inline[]): void {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      if (t.tokens) {
        for (const sub of t.tokens) emitInline(sub, style, out);
      } else {
        out.push({ type: 'text', text: decodeEntities(t.text), ...maybeStyle(style) });
      }
      break;
    }
    case 'strong': {
      const t = token as Tokens.Strong;
      for (const sub of t.tokens) emitInline(sub, { ...style, bold: true }, out);
      break;
    }
    case 'em': {
      const t = token as Tokens.Em;
      for (const sub of t.tokens) emitInline(sub, { ...style, italic: true }, out);
      break;
    }
    case 'codespan': {
      const t = token as Tokens.Codespan;
      out.push({ type: 'text', text: decodeEntities(t.text), style: { ...style, code: true } });
      break;
    }
    case 'del': {
      const t = token as Tokens.Del;
      for (const sub of t.tokens) emitInline(sub, { ...style, strike: true }, out);
      break;
    }
    case 'link': {
      const t = token as Tokens.Link;
      const innerText = (t.tokens || [])
        .map((sub) => {
          const collected: Inline[] = [];
          emitInline(sub, {}, collected);
          return collected.map((el) => (el.type === 'text' ? el.text : el.url)).join('');
        })
        .join('');
      const link: InlineLink = { type: 'link', url: t.href };
      if (innerText && innerText !== t.href) link.text = innerText;
      const s = maybeStyle(style);
      if (s.style) link.style = s.style;
      out.push(link);
      break;
    }
    case 'br': {
      out.push({ type: 'text', text: '\n', ...maybeStyle(style) });
      break;
    }
    case 'escape': {
      const t = token as Tokens.Escape;
      out.push({ type: 'text', text: t.text, ...maybeStyle(style) });
      break;
    }
    case 'html': {
      const t = token as Tokens.HTML;
      out.push({ type: 'text', text: t.text, ...maybeStyle(style) });
      break;
    }
    case 'image': {
      // Slack rich_text doesn't render images inline. Emit alt text + url as link.
      const t = token as Tokens.Image;
      out.push({ type: 'link', url: t.href, text: t.text || t.href });
      break;
    }
    default: {
      const t = token as { text?: string };
      if (t.text) out.push({ type: 'text', text: t.text, ...maybeStyle(style) });
    }
  }
}

function inlineFromBlockToken(token: Token): Inline[] {
  if (token.type === 'paragraph' || token.type === 'text') {
    const t = token as Tokens.Paragraph | Tokens.Text;
    return convertInline(t.tokens || []);
  }
  if ('tokens' in token && token.tokens) return convertInline(token.tokens);
  const t = token as { text?: string };
  return t.text ? [{ type: 'text', text: t.text }] : [];
}

function maybeStyle(style: Style): { style?: Style } {
  const keys = (Object.keys(style) as Array<keyof Style>).filter((k) => style[k]);
  if (keys.length === 0) return {};
  const out: Style = {};
  for (const k of keys) out[k] = true;
  return { style: out };
}

function boldify(el: Inline): Inline {
  const style = { ...el.style, bold: true };
  return { ...el, style };
}

function mergeAdjacentText(els: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const el of els) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === 'text' &&
      el.type === 'text' &&
      stylesEqual(prev.style, el.style)
    ) {
      prev.text += el.text;
    } else {
      out.push({ ...el });
    }
  }
  return out;
}

function stylesEqual(a?: Style, b?: Style): boolean {
  const ka = a ? (Object.keys(a) as Array<keyof Style>).filter((k) => a[k]) : [];
  const kb = b ? (Object.keys(b) as Array<keyof Style>).filter((k) => b[k]) : [];
  if (ka.length !== kb.length) return false;
  ka.sort();
  kb.sort();
  return ka.every((k, i) => k === kb[i]);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Plain-text fallback for a block — used as `text` parameter for notification previews
// and accessibility. Doesn't need to match Slack's rendering exactly.
export function blockToFallbackText(block: RichTextBlock): string {
  const parts: string[] = [];
  for (const el of block.elements) parts.push(elementToText(el));
  return parts.join('\n').trim();
}

function elementToText(el: RichElement): string {
  switch (el.type) {
    case 'rich_text_section':
    case 'rich_text_quote':
      return inlineToText(el.elements);
    case 'rich_text_preformatted':
      return inlineToText(el.elements);
    case 'rich_text_list': {
      const marker = el.style === 'ordered' ? (i: number) => `${i + 1}.` : () => '•';
      const indent = '  '.repeat(el.indent);
      return el.elements
        .map((sec, i) => `${indent}${marker(i)} ${inlineToText(sec.elements)}`)
        .join('\n');
    }
  }
}

function inlineToText(els: Inline[]): string {
  return els
    .map((el) => (el.type === 'text' ? el.text : el.text || el.url))
    .join('');
}

function renderAsciiTable(t: Tokens.Table): string {
  const headers = t.header.map((c) => c.text);
  const rows = t.rows.map((r) => r.map((c) => c.text));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || '').length))
  );
  const fmt = (cells: string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n');
}
