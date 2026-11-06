export function skillMarkdownBody(source: string) {
    // Only a closed metadata block at the document start is frontmatter.
    // Keep ordinary Markdown dividers and unfinished files readable.
    const block = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/.exec(source);
    if (!block || !/^[^\s:#][^:\r\n]*:(?:[\t ]|\r?$)/m.test(block[1])) return source;
    return source.slice(block[0].length);
}
