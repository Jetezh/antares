import type { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * Syntax colours are CSS variables (see index.css), so the editor follows the
 * dashboard's light/dark switch with no re-mount and no duplicated theme.
 */
export const antaresHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword], color: 'var(--syntax-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syntax-string)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syntax-number)' },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: 'var(--syntax-variable)' },
  { tag: [t.typeName, t.className, t.tagName, t.namespace], color: 'var(--syntax-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--syntax-function)' },
  { tag: [t.operator, t.operatorKeyword, t.definitionOperator], color: 'var(--syntax-operator)' },
  { tag: [t.punctuation, t.bracket, t.separator], color: 'var(--syntax-punctuation)' },
  { tag: [t.heading, t.strong], color: 'var(--syntax-heading)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--syntax-link)', textDecoration: 'underline' },
  { tag: [t.invalid], color: 'var(--destructive)' },
])

export const antaresEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--foreground)',
    backgroundColor: 'transparent',
    fontSize: '12.5px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.6',
  },
  '.cm-content': {
    caretColor: 'var(--foreground)',
    padding: '0.75rem 0',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--raised) 55%, transparent)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--dim)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--raised)',
    border: 'none',
    color: 'var(--muted-foreground)',
  },
  '.cm-tooltip': {
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--popover-foreground)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--primary)',
    color: 'var(--primary-foreground)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--card)',
    color: 'var(--foreground)',
    borderColor: 'var(--border)',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, var(--warning) 35%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 35%, transparent)',
  },
})

export function antaresEditorExtensions(dark: boolean): Extension[] {
  return [antaresEditorTheme, syntaxHighlighting(antaresHighlightStyle), EditorView.darkTheme.of(dark)]
}

/** Read the dashboard's current colour scheme (the `.dark` class on <html>). */
export function isDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}
