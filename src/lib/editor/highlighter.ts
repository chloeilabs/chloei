import {
  type BundledLanguage,
  createHighlighter,
  createJavaScriptRegexEngine,
  type Highlighter,
  type ThemeInput,
} from "shiki"

import theme from "./theme.json"

const LANGUAGES: BundledLanguage[] = [
  "typescript",
  "javascript",
  "tsx",
  "ts",
  "jsx",
  "js",
  "json",
  "markdown",
  "css",
  "html",
  "python",
  "go",
  "rust",
  "java",
]

const jsEngine = createJavaScriptRegexEngine({ forgiving: true })

let highlighterPromise: Promise<Highlighter> | null = null

export async function getHighlighter() {
  highlighterPromise ??= createHighlighter({
    themes: [theme as ThemeInput],
    langs: LANGUAGES,
    engine: jsEngine,
  })

  return highlighterPromise
}
