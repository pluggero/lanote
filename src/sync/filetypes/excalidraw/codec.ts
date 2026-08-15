import * as LZString from 'lz-string';

/**
 * Minimal shape of an Excalidraw scene element this codec/merge logic
 * touches. Loosely typed on purpose -- LANote doesn't need Excalidraw's
 * full type union, only the fields `reconcileElements.ts` reads.
 */
export interface ExcalidrawElementLike {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: any;
}

export interface ExcalidrawSceneData {
  type: string;
  version: number;
  source: string;
  elements: ExcalidrawElementLike[];
  appState: Record<string, any>;
  files: Record<string, any>;
}

export interface ExcalidrawFileParts {
  // Everything up to and including the `\`\`\`compressed-json\n` fence-open
  // line: frontmatter, banner, and the `## Text Elements` section (`<text>
  // ^<elementId>` lines). Kept opaque here, but the Excalidraw plugin
  // re-parses this section on load and overwrites the matching element's
  // `.text` with it -- copying it verbatim from one side after a merge can
  // revert a correctly-merged element's text. patchTextElementsMirror in
  // reconcileElements.ts corrects that.
  shellPrefix: string;
  // The closing `\`\`\`` fence line onward (typically just `\`\`\`\n%%`).
  shellSuffix: string;
  sceneData: ExcalidrawSceneData;
}

// Matches the Excalidraw plugin's own line width (256 chars, blank line
// between chunks) for cosmetic parity -- not load-bearing, since base64
// decoding ignores whitespace.
const BASE64_WRAP_WIDTH = 256;

const COMPRESSED_JSON_FENCE = /```compressed-json\n([\s\S]*?)\n```/;

/**
 * Splits a `*.excalidraw.md` file into its verbatim shell and its decoded
 * scene data. Returns null (never throws) if the file doesn't contain a
 * `compressed-json` fence, or if the fenced payload fails to decompress or
 * parse as a scene -- callers must treat that as "not mergeable this way"
 * and fall back to a different resolution, not as a fatal error.
 */
export function parseExcalidrawMd(text: string): ExcalidrawFileParts | null {
  const match = COMPRESSED_JSON_FENCE.exec(text);
  if (!match) return null;

  const base64Payload = (match[1] ?? '').replace(/\s+/g, '');
  let decompressed: string | null;
  try {
    decompressed = LZString.decompressFromBase64(base64Payload);
  } catch {
    return null;
  }
  if (!decompressed) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(decompressed);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.elements)) return null;

  const sceneData: ExcalidrawSceneData = {
    type: parsed.type,
    version: parsed.version,
    source: parsed.source,
    elements: parsed.elements,
    appState: parsed.appState ?? {},
    files: parsed.files ?? {},
  };

  const shellPrefix = text.slice(0, match.index) + '```compressed-json\n';
  const shellSuffix = '```' + text.slice(match.index + match[0].length);
  return { shellPrefix, shellSuffix, sceneData };
}

/** Inverse of parseExcalidrawMd: re-compresses sceneData and reassembles the file around it. */
export function serializeExcalidrawMd(parts: ExcalidrawFileParts): string {
  const compressed = LZString.compressToBase64(JSON.stringify(parts.sceneData));
  const wrapped = wrapBase64(compressed);
  return parts.shellPrefix + wrapped + '\n' + parts.shellSuffix;
}

function wrapBase64(base64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += BASE64_WRAP_WIDTH) {
    lines.push(base64.slice(i, i + BASE64_WRAP_WIDTH));
  }
  return lines.join('\n\n');
}
