// Light markdown for long text: links, bare URLs, **bold**, *italic*, `code`,
// headings and list items. Everything else, including line breaks, is kept as
// typed. It yields a tree, never HTML, so shared text cannot inject markup.
export type Mark =
  | string
  | {
      tag: "a" | "strong" | "em" | "code" | "h" | "li";
      href?: string;
      // The marker a list item was typed with, e.g. "-" or "2.".
      marker?: string;
      children: Mark[];
    };
const inlineRule =
  /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|(https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"])|\*\*(?=\S)([^\n]*?\S)\*\*|(?<![\w*])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![\w*])|(?<!\w)_(?=[^\s_])([^\n_]*?[^\s_])_(?!\w)|`([^`\n]+)`/g;
function inline(text: string): Mark[] {
  const out: Mark[] = [];
  let last = 0;
  for (const m of text.matchAll(inlineRule)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined)
      out.push({ tag: "a", href: m[2], children: inline(m[1]) });
    else if (m[3] !== undefined)
      out.push({ tag: "a", href: m[3], children: [m[3]] });
    else if (m[4] !== undefined)
      out.push({ tag: "strong", children: inline(m[4]) });
    else if (m[5] !== undefined || m[6] !== undefined)
      out.push({ tag: "em", children: inline(m[5] ?? m[6]) });
    else out.push({ tag: "code", children: [m[7]] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function markdown(text: string): Mark[] {
  const out: Mark[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line),
      item = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) out.push({ tag: "h", children: inline(heading[1]) });
    else if (item)
      out.push({
        tag: "li",
        marker: /\d/.test(item[2]) ? item[2] : "•",
        children: inline(item[3]),
      });
    else {
      out.push(...inline(line));
      // Blocks end their own line; other lines keep the break they were typed with.
      if (i < lines.length - 1) out.push("\n");
    }
  });
  return out;
}
