/**
 * GraphQL Query/Mutation → Apollo Resolver Synthesizer
 *
 * Bridges frontend GraphQL operations written in JS/TS/Vue template literals
 * (e.g. `query GetCharts($page: Int) { freeChartList(page: $page) { ... } }`
 * or `mutation createNote(...) { createNote(...) { id } }`) to the matching
 * backend Apollo/GraphQL resolver functions defined under `Query: { ... }`,
 * `Mutation: { ... }`, or `Subscription: { ... }` (or `@Query`/`@Mutation`/
 * `@Subscription` decorated methods).
 *
 * Precision guards:
 *   1. Target must be a resolver function/method physically declared inside a
 *      `Query` / `Mutation` / `Subscription` resolver block (excluding nested
 *      helper functions inside a resolver body) or carrying a matching GraphQL
 *      decorator — never an arbitrary JS function of the same name.
 *   2. Operation type must match (`query` ↔ `Query`, `mutation` ↔ `Mutation`,
 *      `subscription` ↔ `Subscription`).
 *   3. Only root-level fields of a syntactically valid GraphQL operation
 *      selection set inside a template literal are extracted — nested fields
 *      and plain strings are ignored.
 *   4. In monorepos (`packages/<pkg>/`, `apps/<pkg>/`), multiple matching
 *      resolvers are disambiguated by matching package name first.
 */

import { Edge, Node } from '../types';
import { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';

export type GraphqlOpType = 'query' | 'mutation' | 'subscription';

export interface GraphqlOperationField {
  opType: GraphqlOpType;
  fieldName: string;
  /** 1-indexed line number in the source file where the root field appears. */
  line: number;
}

interface ResolverBlock {
  opType: GraphqlOpType;
  startLine: number;
  endLine: number;
}

const JS_TS_EXT = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const FRONTEND_EXT = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|vue)$/i;
const RESOLVER_KEY_TO_OP: Record<string, GraphqlOpType> = {
  Query: 'query',
  Mutation: 'mutation',
  Subscription: 'subscription',
};
const GQL_INTERP_TOKEN = '__GQL_INTERP__';

/** Extract monorepo package/app segment (e.g. `packages/ag-overseas/` → `ag-overseas`). */
function extractMonorepoPackage(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, '/');
  const m = norm.match(/(?:^|\/)(?:packages|apps|services|modules)\/([^/]+)\//);
  return m ? m[1]! : null;
}

/** Count newlines in `s.slice(from, to)`. */
function countNewlines(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

/**
 * Skip a JS/TS string, template literal, or comment starting at `i`.
 * Returns the index immediately AFTER the skipped token, or `-1` if `src[i]`
 * is not the start of a comment/string/template.
 */
function skipJsTrivia(src: string, i: number): number {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === '/' && next === '/') {
    let j = i + 2;
    while (j < src.length && src[j] !== '\n') j++;
    return j;
  }
  if (ch === '/' && next === '*') {
    let j = i + 2;
    while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
    return Math.min(src.length, j + 2);
  }
  if (ch === "'" || ch === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== ch) {
      if (src[j] === '\\') j++;
      j++;
    }
    return Math.min(src.length, j + 1);
  }
  if (ch === '`') {
    return skipTemplateLiteral(src, i);
  }
  return -1;
}

/** Skip a JS/TS template literal starting at the opening `` ` `` at `start`. */
function skipTemplateLiteral(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && src[i + 1] === '{') {
      i = skipBalancedBraces(src, i + 1);
      continue;
    }
    i++;
  }
  return src.length;
}

/** Skip from an opening `{` at `openIdx` to the index right after its matching `}`. */
function skipBalancedBraces(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const skipped = skipJsTrivia(src, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const ch = src[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

/**
 * Find `Query: { ... }`, `Mutation: { ... }`, `Subscription: { ... }` blocks
 * (and `const Query = { ... }` variable blocks) in a JS/TS file, returning
 * 1-indexed line spans.
 */
export function findResolverBlocks(src: string): ResolverBlock[] {
  const blocks: ResolverBlock[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  let i = 0;
  while (i < src.length) {
    const skipped = skipJsTrivia(src, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const ch = src.charCodeAt(i);
    // Fast check: only 'Q', 'M', 'S' can start Query/Mutation/Subscription
    if (ch === 81 || ch === 77 || ch === 83) {
      const prev = i > 0 ? src[i - 1]! : '';
      if (!/[A-Za-z0-9_$.]/.test(prev)) {
        let key: string | null = null;
        if (src.startsWith('Query', i)) key = 'Query';
        else if (src.startsWith('Mutation', i)) key = 'Mutation';
        else if (src.startsWith('Subscription', i)) key = 'Subscription';

        if (key) {
          const afterKey = i + key.length;
          const nextChar = src[afterKey] ?? '';
          if (!/[A-Za-z0-9_$]/.test(nextChar)) {
            let j = afterKey;
            while (j < src.length && /\s/.test(src[j]!)) j++;
            let openBrace = -1;
            if (src[j] === ':') {
              // Property form: `Query: { ... }` (skip TS type annotations like `foo: Query`)
              j++;
              while (j < src.length && /\s/.test(src[j]!)) j++;
              if (src[j] === '{') openBrace = j;
            } else if (src[j] === '=') {
              // Variable form: `const Query = { ... }` (not `==` or `=>`)
              if (src[j + 1] !== '=' && src[j + 1] !== '>') {
                const before = src.slice(Math.max(0, i - 24), i);
                if (/(?:const|let|var|exports\.)\s*$/.test(before)) {
                  j++;
                  while (j < src.length && /\s/.test(src[j]!)) j++;
                  if (src[j] === '{') openBrace = j;
                }
              }
            }
            if (openBrace !== -1) {
              const closeAfter = skipBalancedBraces(src, openBrace);
              const opType = RESOLVER_KEY_TO_OP[key]!;
              blocks.push({
                opType,
                startLine: lineOf(openBrace),
                endLine: lineOf(Math.max(openBrace, closeAfter - 1)),
              });
              // Do not jump past closeAfter — nested blocks won't match Query/Mutation
              // at resolver level, and scanning forward is O(n) total.
            }
          }
        }
      }
    }
    i++;
  }
  return blocks;
}

/**
 * Extract template literal contents from JS/TS source, flattening `${...}`
 * interpolations into newline-preserving `__GQL_INTERP__` placeholders so
 * GraphQL parsing keeps exact line numbers.
 */
function extractTemplateLiterals(src: string): Array<{ text: string; startLine: number }> {
  const templates: Array<{ text: string; startLine: number }> = [];
  let line = 1;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = skipJsTrivia(src, i);
      line += countNewlines(src, i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipJsTrivia(src, i);
      line += countNewlines(src, i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      i++; // past opening backtick
      let buf = '';
      while (i < src.length) {
        const tc = src[i];
        if (tc === '\\') {
          if (src[i + 1] === '\n') {
            line++;
            buf += '\n';
          } else {
            buf += tc + (src[i + 1] ?? '');
          }
          i += 2;
          continue;
        }
        if (tc === '`') {
          i++;
          break;
        }
        if (tc === '$' && src[i + 1] === '{') {
          const end = skipBalancedBraces(src, i + 1);
          const nl = countNewlines(src, i, end);
          line += nl;
          buf += ` ${GQL_INTERP_TOKEN}` + '\n'.repeat(nl) + ' ';
          i = end;
          continue;
        }
        if (tc === '\n') line++;
        buf += tc;
        i++;
      }
      templates.push({ text: buf, startLine });
      continue;
    }
    i++;
  }

  return templates;
}

/** Skip GraphQL whitespace and `# ...` comments. */
function skipGqlWs(s: string, i: number): number {
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    break;
  }
  return i;
}

/** Skip a GraphQL string literal (`"..."` or `"""..."""`) starting at `i`. */
function skipGqlString(s: string, i: number): number {
  if (s.startsWith('"""', i)) {
    let j = i + 3;
    while (j < s.length && !s.startsWith('"""', j)) {
      if (s[j] === '\\') j++;
      j++;
    }
    return Math.min(s.length, j + 3);
  }
  let j = i + 1;
  while (j < s.length && s[j] !== '"') {
    if (s[j] === '\\') j++;
    j++;
  }
  return Math.min(s.length, j + 1);
}

/** Skip a balanced delimiter pair (`(...)` or `{...}`) in GraphQL text. */
function skipGqlBalanced(s: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      i = skipGqlString(s, i);
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return s.length;
}

/** Read a GraphQL identifier starting at `i`, returning `[name, nextIndex]` or `null`. */
function readGqlIdent(s: string, i: number): [string, number] | null {
  if (i >= s.length || !/[A-Za-z_]/.test(s[i]!)) return null;
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
  return [s.slice(i, j), j];
}

/**
 * Parse GraphQL `query` / `mutation` / `subscription` operations from a
 * flattened template literal body and return their root selection-set fields.
 */
function parseGraphqlTemplate(text: string, startLine: number): GraphqlOperationField[] {
  const results: GraphqlOperationField[] = [];
  const opHeaderRe = /(?:^|[\n\r;{}])\s*(query|mutation|subscription)\b/g;
  let match: RegExpExecArray | null;

  while ((match = opHeaderRe.exec(text)) !== null) {
    const opType = match[1] as GraphqlOpType;
    let i = match.index + match[0].length;
    i = skipGqlWs(text, i);

    // Optional operation name (e.g. `GetCharts` or `${operationName}` → `__GQL_INTERP__`)
    const opName = readGqlIdent(text, i);
    if (opName) {
      i = skipGqlWs(text, opName[1]);
    }

    // Optional variable definitions: `($a: Int!, $b: String)`
    if (text[i] === '(') {
      i = skipGqlBalanced(text, i, '(', ')');
      i = skipGqlWs(text, i);
    }

    // Optional operation-level directives: `@cached(ttl: 60)`
    while (text[i] === '@') {
      const dir = readGqlIdent(text, i + 1);
      if (!dir) break;
      i = skipGqlWs(text, dir[1]);
      if (text[i] === '(') {
        i = skipGqlBalanced(text, i, '(', ')');
        i = skipGqlWs(text, i);
      }
    }

    // Must immediately open the root selection set `{` — rejects plain prose
    // like "query the database".
    if (text[i] !== '{') continue;
    const rootClose = skipGqlBalanced(text, i, '{', '}');
    let j = i + 1;

    while (j < rootClose - 1) {
      j = skipGqlWs(text, j);
      if (j >= rootClose - 1) break;
      const ch = text[j]!;

      // Fragment spread `...Frag` or inline fragment `... on Type { ... }`
      if (text.startsWith('...', j)) {
        j = skipGqlWs(text, j + 3);
        const id = readGqlIdent(text, j);
        if (id) {
          j = skipGqlWs(text, id[1]);
          if (id[0] === 'on') {
            const typeId = readGqlIdent(text, j);
            if (typeId) j = skipGqlWs(text, typeId[1]);
          }
        }
        continue;
      }

      // Directives `@include(...)`
      if (ch === '@') {
        const dir = readGqlIdent(text, j + 1);
        j = dir ? skipGqlWs(text, dir[1]) : j + 1;
        if (text[j] === '(') j = skipGqlBalanced(text, j, '(', ')');
        continue;
      }

      // Field arguments `(...)` or nested selection set `{ ... }`
      if (ch === '(') {
        j = skipGqlBalanced(text, j, '(', ')');
        continue;
      }
      if (ch === '{') {
        j = skipGqlBalanced(text, j, '{', '}');
        continue;
      }
      if (ch === '"') {
        j = skipGqlString(text, j);
        continue;
      }

      const ident = readGqlIdent(text, j);
      if (!ident) {
        j++;
        continue;
      }
      const [firstWord, afterFirst] = ident;
      const fieldStartOffset = j;
      j = skipGqlWs(text, afterFirst);

      if (firstWord === GQL_INTERP_TOKEN) continue;

      let fieldName = firstWord;
      let fieldOffset = fieldStartOffset;
      // Handle GraphQL field alias: `alias: realFieldName`
      if (text[j] === ':') {
        j = skipGqlWs(text, j + 1);
        const real = readGqlIdent(text, j);
        if (!real) continue;
        fieldName = real[0];
        fieldOffset = j;
        j = skipGqlWs(text, real[1]);
      }

      if (fieldName === GQL_INTERP_TOKEN || fieldName.startsWith('__')) {
        continue;
      }

      const fieldLine = startLine + countNewlines(text, 0, fieldOffset);
      results.push({ opType, fieldName, line: fieldLine });
    }

    // Advance regex past this selection set so nested `{ ... }` aren't re-scanned
    opHeaderRe.lastIndex = rootClose;
  }

  return results;
}

/**
 * Extract all GraphQL operation root fields from JS/TS/Vue source code.
 * For `.vue` files, scans only `<script>` blocks.
 */
export function extractGraphqlOperations(source: string, filePath: string): GraphqlOperationField[] {
  const results: GraphqlOperationField[] = [];

  if (filePath.endsWith('.vue')) {
    const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(source)) !== null) {
      const content = m[1]!;
      const openEnd = m.index + m[0].indexOf('>') + 1;
      const scriptBaseLine = countNewlines(source, 0, openEnd); // 0-indexed offset
      for (const tpl of extractTemplateLiterals(content)) {
        if (!/\b(?:query|mutation|subscription)\b/.test(tpl.text)) continue;
        for (const op of parseGraphqlTemplate(tpl.text, tpl.startLine + scriptBaseLine)) {
          results.push(op);
        }
      }
    }
    return results;
  }

  for (const tpl of extractTemplateLiterals(source)) {
    if (!/\b(?:query|mutation|subscription)\b/.test(tpl.text)) continue;
    for (const op of parseGraphqlTemplate(tpl.text, tpl.startLine)) {
      results.push(op);
    }
  }
  return results;
}

const OWNER_KINDS = new Set(['function', 'method', 'constant', 'variable']);

/** Find innermost function/method/constant/variable node enclosing `line`. */
function enclosingQueryOwner(nodesInFile: Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodesInFile) {
    if (!OWNER_KINDS.has(n.kind)) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= line && end >= line) {
      if (!best || n.startLine >= best.startLine) best = n;
    }
  }
  if (best) return best;
  return (
    nodesInFile.find((n) => n.kind === 'component') ??
    nodesInFile.find((n) => n.kind === 'file') ??
    null
  );
}

function decoratorOpType(decorators: string[] | undefined): GraphqlOpType | null {
  if (!decorators || decorators.length === 0) return null;
  for (const d of decorators) {
    if (/^@?Query(?:\b|\()/.test(d)) return 'query';
    if (/^@?Mutation(?:\b|\()/.test(d)) return 'mutation';
    if (/^@?Subscription(?:\b|\()/.test(d)) return 'subscription';
  }
  return null;
}

/**
 * Synthesize `calls` edges from frontend GraphQL query/mutation builders to
 * their matching backend Apollo/GraphQL resolver functions.
 */
export async function graphqlResolverEdges(
  ctx: ResolutionContext,
  onYield: MaybeYield
): Promise<Edge[]> {
  const allFiles = ctx.getAllFiles();
  // Map `${opType}:${fieldName}` -> candidate resolver nodes
  const resolversByKey = new Map<string, Node[]>();
  const addResolver = (opType: GraphqlOpType, node: Node) => {
    const key = `${opType}:${node.name}`;
    let list = resolversByKey.get(key);
    if (!list) {
      list = [];
      resolversByKey.set(key, list);
    }
    list.push(node);
  };

  let scanned = 0;
  for (const file of allFiles) {
    if ((++scanned & 31) === 0) await onYield();
    if (!JS_TS_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (
      !content ||
      (!content.includes('Query') &&
        !content.includes('Mutation') &&
        !content.includes('Subscription'))
    ) {
      continue;
    }

    const blocks = findResolverBlocks(content);
    const hasDecoratorHint =
      content.includes('@Query') ||
      content.includes('@Mutation') ||
      content.includes('@Subscription');
    if (blocks.length === 0 && !hasDecoratorHint) continue;

    const nodesInFile = ctx.getNodesInFile(file);
    const fnNodes = nodesInFile.filter((n) => n.kind === 'function' || n.kind === 'method');
    if (fnNodes.length === 0) continue;

    const seenInFile = new Set<string>();
    for (const block of blocks) {
      const inBlock = fnNodes.filter(
        (n) => n.startLine >= block.startLine && n.startLine <= block.endLine
      );
      for (const n of inBlock) {
        // Exclude local helper functions declared inside a resolver's body
        const nEnd = n.endLine ?? n.startLine;
        const isNestedHelper = inBlock.some(
          (other) =>
            other.id !== n.id &&
            other.startLine < n.startLine &&
            (other.endLine ?? other.startLine) >= nEnd
        );
        if (isNestedHelper) continue;
        const k = `${block.opType}:${n.id}`;
        if (!seenInFile.has(k)) {
          seenInFile.add(k);
          addResolver(block.opType, n);
        }
      }
    }

    if (hasDecoratorHint) {
      for (const n of fnNodes) {
        const opType = decoratorOpType(n.decorators);
        if (!opType) continue;
        const k = `${opType}:${n.id}`;
        if (!seenInFile.has(k)) {
          seenInFile.add(k);
          addResolver(opType, n);
        }
      }
    }
  }

  if (resolversByKey.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();
  let scannedFrontend = 0;

  for (const file of allFiles) {
    if ((++scannedFrontend & 31) === 0) await onYield();
    if (!FRONTEND_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('`')) continue;
    if (
      !content.includes('query') &&
      !content.includes('mutation') &&
      !content.includes('subscription')
    ) {
      continue;
    }

    const ops = extractGraphqlOperations(content, file);
    if (ops.length === 0) continue;

    const nodesInFile = ctx.getNodesInFile(file);
    if (nodesInFile.length === 0) continue;
    const srcPkg = extractMonorepoPackage(file);

    for (const op of ops) {
      const allCands = resolversByKey.get(`${op.opType}:${op.fieldName}`);
      if (!allCands || allCands.length === 0) continue;

      const crossFile = allCands.filter((c) => c.filePath !== file);
      if (crossFile.length === 0) continue;

      let targets: Node[];
      if (crossFile.length === 1) {
        targets = crossFile;
      } else if (srcPkg) {
        const samePkg = crossFile.filter((c) => extractMonorepoPackage(c.filePath) === srcPkg);
        targets = samePkg.length > 0 ? samePkg : [];
      } else {
        // Ambiguous across multiple packages with no package signal — skip
        targets = [];
      }
      if (targets.length === 0) continue;

      const owner = enclosingQueryOwner(nodesInFile, op.line);
      if (!owner) continue;

      for (const target of targets) {
        const edgeKey = `${owner.id}>${target.id}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        edges.push({
          source: owner.id,
          target: target.id,
          kind: 'calls',
          line: op.line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'graphql-resolver',
            operation: op.opType,
            field: op.fieldName,
          },
        });
      }
    }
  }

  return edges;
}
