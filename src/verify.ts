/**
 * verify — Phase 1 受け入れ条件の検証 CLI
 *
 * 訳 docx を再度 reader に通し、構造が保持されているかを機械検証する。
 *   1. docxToDtir → validateDtir が空（DTIR 健全性）
 *   2. 元 docx と訳 docx のセグメント数・id 集合が一致（構造保持）
 *
 * 使い方:
 *   npx tsx src/verify.ts <translated.docx> [original.docx]
 *
 *   original.docx を渡すと 2 の比較も行う。省略時は 1 のみ。
 *
 * LibreOffice 互換確認（手動・任意）:
 *   soffice --headless --convert-to pdf <translated.docx>
 */
import { readFileSync } from 'node:fs';
import { validateDtir } from '@shuji-bonji/doc-translation-ir/validate';
import { docxToDtir } from '@shuji-bonji/dtir-ooxml-reader-mcp/reader';

const [translatedPath, originalPath] = process.argv.slice(2);
if (!translatedPath) {
  console.error('usage: npx tsx src/verify.ts <translated.docx> [original.docx]');
  process.exit(2);
}

let failed = false;
const check = (ok: boolean, label: string, detail = '') => {
  console.error(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

// 1. 訳 docx → DTIR → validateDtir
const translated = await docxToDtir(readFileSync(translatedPath), {
  fileName: translatedPath,
});
const issues = validateDtir(translated);
check(issues.length === 0, 'validateDtir が空', `issues=${issues.length}`);
for (const i of issues) console.error(`   [${i.code}] ${i.segmentId ?? '(doc)'}: ${i.message}`);

// 2. 元 docx との構造比較（任意）
if (originalPath) {
  const original = await docxToDtir(readFileSync(originalPath), { fileName: originalPath });
  check(
    original.segments.length === translated.segments.length,
    'セグメント数が一致',
    `original=${original.segments.length} translated=${translated.segments.length}`,
  );
  const oIds = new Set(original.segments.map((s) => s.id));
  const tIds = new Set(translated.segments.map((s) => s.id));
  const missing = [...oIds].filter((id) => !tIds.has(id));
  const extra = [...tIds].filter((id) => !oIds.has(id));
  check(
    missing.length === 0 && extra.length === 0,
    'セグメント id 集合が一致',
    missing.length + extra.length > 0 ? `missing=${missing.join(',')} extra=${extra.join(',')}` : '',
  );
}

console.error(failed ? '--- NG ---' : '--- OK ---');
process.exit(failed ? 1 : 0);
