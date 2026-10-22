import type { Extension } from '@codemirror/state'

/**
 * Language grammars are loaded on demand: a CodeMirror language pack is far
 * larger than the editor core, and a session usually edits one language. The
 * first frame renders plain text; highlighting appears once the grammar's chunk
 * arrives (cached per extension).
 */
type Loader = () => Promise<Extension>

const LOADERS: Record<string, Loader> = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  mts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  cts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () =>
    import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  pyw: () => import('@codemirror/lang-python').then((m) => m.python()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  htm: () => import('@codemirror/lang-html').then((m) => m.html()),
  vue: () => import('@codemirror/lang-html').then((m) => m.html()),
  svelte: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => import('@codemirror/lang-css').then((m) => m.css()),
  less: () => import('@codemirror/lang-css').then((m) => m.css()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  jsonc: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  mdx: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  svg: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  plist: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  h: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cc: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cxx: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  hpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  hh: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
}

const cache = new Map<string, Extension | null>()

function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

/** Load (and cache) the syntax grammar for a file, or null for plain text. */
export async function loadLanguageForFile(fileName: string): Promise<Extension | null> {
  const ext = extensionOf(fileName)
  if (cache.has(ext)) return cache.get(ext)!
  const loader = LOADERS[ext]
  if (!loader) {
    cache.set(ext, null)
    return null
  }
  try {
    const language = await loader()
    cache.set(ext, language)
    return language
  } catch {
    cache.set(ext, null)
    return null
  }
}

/** True when the file is a Markdown document with a rendered preview. */
export function isMarkdownFile(fileName: string): boolean {
  const ext = extensionOf(fileName)
  return ext === 'md' || ext === 'markdown' || ext === 'mdx'
}
