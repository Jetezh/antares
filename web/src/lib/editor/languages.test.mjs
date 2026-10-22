import { test, expect } from 'bun:test'
import { isMarkdownFile, loadLanguageForFile } from './languages.ts'

test('loads a grammar for common source extensions', async () => {
  for (const name of ['main.go', 'app.tsx', 'index.ts', 'script.py', 'page.html', 'style.css', 'data.json']) {
    expect(await loadLanguageForFile(name)).not.toBeNull()
  }
})

test('unknown or plain-text files fall back to null', async () => {
  for (const name of ['README', 'notes.unknown', 'run.sh', '.env', 'Makefile', 'log.txt']) {
    expect(await loadLanguageForFile(name)).toBeNull()
  }
})

test('markdown detection is case-insensitive', () => {
  expect(isMarkdownFile('README.md')).toBe(true)
  expect(isMarkdownFile('guide.MDX')).toBe(true)
  expect(isMarkdownFile('main.go')).toBe(false)
})
