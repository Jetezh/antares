import { memo, useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  lineNumbers,
  keymap,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { loadLanguageForFile } from '@/lib/editor/languages'
import { antaresEditorExtensions, isDarkMode } from '@/lib/editor/theme'

interface CodeEditorProps {
  fileName: string
  /** Authoritative text. Applied on mount and whenever docVersion changes. */
  value: string
  /**
   * Bump to replace the document with `value` (an agent edit, a reload, a
   * discard). Ordinary typing does not change it, so the caret is never reset
   * under the user.
   */
  docVersion: number
  readOnly?: boolean
  onChange: (value: string) => void
  onSave: (value: string) => void
}

function buildExtensions(
  compartment: Compartment,
  readOnly: boolean,
  onChange: (value: string) => void,
  onSave: (value: string) => void,
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    ...antaresEditorExtensions(isDarkMode()),
    EditorState.readOnly.of(readOnly),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: (view) => (onSave(view.state.doc.toString()), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString())
    }),
    compartment.of([]),
  ]
}

/**
 * A thin, uncontrolled CodeMirror 6 wrapper. It is uncontrolled on purpose: a
 * controlled editor would dispatch a document replacement on every keystroke
 * and fight the user's caret. External replacements are explicit via
 * `docVersion`.
 */
export const CodeEditor = memo(function CodeEditor({
  fileName,
  value,
  docVersion,
  readOnly = false,
  onChange,
  onSave,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useEffect(() => {
    if (!hostRef.current) return
    let cancelled = false
    const compartment = languageCompartment.current
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions(
          compartment,
          readOnly,
          (next) => onChangeRef.current(next),
          (next) => onSaveRef.current(next),
        ),
      }),
      parent: hostRef.current,
    })
    viewRef.current = view

    // Plain text first, highlighting when the (lazily imported) grammar lands.
    void loadLanguageForFile(fileName).then((language) => {
      if (!cancelled && language) view.dispatch({ effects: compartment.reconfigure(language) })
    })

    return () => {
      cancelled = true
      view.destroy()
      viewRef.current = null
    }
    // A new file remounts via key={file.path} in the parent; the rest is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docVersion])

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />
})
