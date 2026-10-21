import { describe, expect, test } from 'bun:test'
import { buildListTree } from './Markdown'

describe('Markdown list nesting (buildListTree)', () => {
  test('correctly nests unordered children under ordered parents', () => {
    const rawItems = [
      { indent: 0, ordered: true, start: 1, text: 'Automated Tenant Scoring & Background Check' },
      { indent: 3, ordered: false, text: 'Problem Pasar: Pemilik kos paling takut...' },
      { indent: 3, ordered: false, text: 'Fitur Bilik: Form verifikasi calon penghuni...' },
      { indent: 0, ordered: true, start: 2, text: 'Sub-metering & Utility Splitter' },
      { indent: 3, ordered: false, text: 'Problem Pasar: Kamar kos sering kali...' },
      { indent: 3, ordered: false, text: 'Fitur Bilik: Modul pencatatan meteran...' },
      { indent: 0, ordered: true, start: 3, text: 'Hyperlocal On-Demand Service Marketplace' },
      { indent: 3, ordered: false, text: 'Pola di Flippa: Platform rental...' },
      { indent: 3, ordered: false, text: 'Fitur Bilik: Dashboard anak kos...' },
    ]

    const tree = buildListTree(rawItems)

    expect(tree).toHaveLength(3)

    // Item 1
    expect(tree[0].text).toBe('Automated Tenant Scoring & Background Check')
    expect(tree[0].ordered).toBe(true)
    expect(tree[0].children).toHaveLength(2)
    expect(tree[0].children[0].text).toBe('Problem Pasar: Pemilik kos paling takut...')
    expect(tree[0].children[0].ordered).toBe(false)
    expect(tree[0].children[1].text).toBe('Fitur Bilik: Form verifikasi calon penghuni...')
    expect(tree[0].children[1].ordered).toBe(false)

    // Item 2
    expect(tree[1].text).toBe('Sub-metering & Utility Splitter')
    expect(tree[1].ordered).toBe(true)
    expect(tree[1].children).toHaveLength(2)
    expect(tree[1].children[0].text).toBe('Problem Pasar: Kamar kos sering kali...')
    expect(tree[1].children[1].text).toBe('Fitur Bilik: Modul pencatatan meteran...')

    // Item 3
    expect(tree[2].text).toBe('Hyperlocal On-Demand Service Marketplace')
    expect(tree[2].ordered).toBe(true)
    expect(tree[2].children).toHaveLength(2)
    expect(tree[2].children[0].text).toBe('Pola di Flippa: Platform rental...')
    expect(tree[2].children[1].text).toBe('Fitur Bilik: Dashboard anak kos...')
  })

  test('handles multi-level nesting', () => {
    const rawItems = [
      { indent: 0, ordered: false, text: 'Level 1' },
      { indent: 2, ordered: false, text: 'Level 2' },
      { indent: 4, ordered: false, text: 'Level 3' },
      { indent: 0, ordered: false, text: 'Level 1 sibling' },
    ]

    const tree = buildListTree(rawItems)
    expect(tree).toHaveLength(2)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].children).toHaveLength(1)
    expect(tree[0].children[0].children[0].text).toBe('Level 3')
    expect(tree[1].text).toBe('Level 1 sibling')
  })
})
