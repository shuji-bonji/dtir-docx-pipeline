/**
 * pipeline-e2e — reader → translate(実DeepL訳) → writer の本物 end-to-end
 *
 * 実 DeepL MCP で取得した訳マップ(test/fixtures/real-deepl-map.json)を
 * StaticMapTranslator で流し込み、混在言語 docx → 本物の訳 docx を生成する。
 * 3つの MCP パッケージを束ねる唯一の場所（ここだけが全部に依存する）。
 *
 * 実行: tsx test/pipeline-e2e.ts [outDir]   （既定 outDir: ./demo-out）
 *
 * 前提: 依存パッケージ(reader/writer/translate)がビルド済みであること
 *   （各リポジトリで npm run build → dist 生成）。pipeline は dist を消費する。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { StaticMapTranslator } from '@shuji-bonji/dtir-translate-mcp/translate';
import { fixtureDocxPath } from '@shuji-bonji/doc-translation-ir/fixtures';
import { translateDocx } from '../src/pipeline.js';

const here = dirname(fileURLToPath(import.meta.url));
const mapPath = resolve(here, 'fixtures/real-deepl-map.json');

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;

async function docXml(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return (await zip.file('word/document.xml')?.async('string')) ?? '';
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? resolve(here, '..', 'demo-out');
  const orig = readFileSync(fixtureDocxPath);
  const rawMap = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>;
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawMap)) if (!k.startsWith('_')) map[k] = v;

  const failures: string[] = [];
  const ok = (c: boolean, m: string) => {
    if (!c) failures.push(m);
  };

  // reader → translate(実訳) → writer
  const translator = new StaticMapTranslator(map);
  const { docx: out, dtir, stats } = await translateDocx(orig, translator, {
    fileName: 'mixed-nl-fr-de-tricky.docx',
    targetLang: 'en-GB',
  });

  // バッチ集約: 言語グループ数ぶんしか呼んでいない
  ok(translator.batchCalls === dtir.stats.groupCount, `batchCalls ${translator.batchCalls} != groups ${dtir.stats.groupCount}`);

  // 実訳注入
  const xml = await docXml(out);
  ok(xml.includes('First-quarter results exceed forecasts.'), '仏→英の実訳が docx に無い');
  ok(xml.includes('Production was fully automated in April.'), '独→英の実訳が docx に無い');
  ok(xml.includes('Annual report 2025'), '蘭→英の実訳が docx に無い');
  // 非翻訳は保持
  ok(xml.includes('Resultaten'), 'TOCキャッシュが消えた');
  ok(xml.includes('1.250.000'), '数値が消えた');

  // 出力
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'mixed-nl-fr-de-tricky.en-GB.docx'), out);
  writeFileSync(join(outDir, 'translated.dtir.json'), `${JSON.stringify(dtir, null, 2)}\n`);

  console.error('\nsource → translation（実 DeepL, en-GB）:');
  for (const s of dtir.segments) {
    if (s.translatable && s.translation) {
      console.error(`  [${s.group}] ${JSON.stringify(s.text.source)} → ${JSON.stringify(s.translation.text)}`);
    }
  }
  console.error(`\nstats: translated=${stats.translated}, batchCalls=${stats.batchCalls} (=言語グループ数)`);

  if (failures.length === 0) {
    console.error(GREEN('\nPIPELINE E2E PASS — reader→translate(実DeepL)→writer で本物の訳docxを生成'));
    process.exit(0);
  }
  console.error(RED(`\nFAIL — ${failures.length} 件`));
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
