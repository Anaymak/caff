'use client'

type Cell = string | number | boolean | null | undefined

// Quotes every cell and neutralises leading = + - @ so spreadsheets never run a formula from player-entered text.
export function toCsv(rows: Cell[][]): string {
  return rows.map((row) => row.map((cell) => {
    let text = cell === null || cell === undefined ? '' : String(cell)
    if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }).join(',')).join('\r\n')
}

export function downloadCsv(filename: string, rows: Cell[][]) {
  const url = URL.createObjectURL(new Blob([`﻿${toCsv(rows)}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
