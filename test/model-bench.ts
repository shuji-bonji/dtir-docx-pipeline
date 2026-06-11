/**
 * model-bench — 複数モデルを同一 docx で翻訳し xCOMET で客観比較する（Phase 3）
 *
 * 使い方:
 *   MODELS="aya-expanse:8b,tower-plus:9b,gemma4:latest" \
 *   LLM_BASE_URL=http://neko8.local:11434/v1 TARGET_LANG=ja \
 *   XCOMET_PYTHON_PATH=~/.xcomet-venv/bin/python3 \
 *     npx tsx test/model-bench.ts [input.docx]
 *
 *   入力省略時は doc-translation-ir 同梱フィクスチャ。
 *   結果は Markdown 表で stdout に出力（リダイレクトでそのまま記事に貼れる）。
 *
 * xCOMET サーバは1プロセスを全モデルで使い回す（モデル常駐＝ロード1回）。
 */
import { readFileSync } from 'node:fs';
import { fixtureDocxPath } from '@shuji-bonji/doc-translation-ir/fixtures';
import { DeeplHttpTranslator, LlmTranslator } from '@shuji-bonji/dtir-translate-mcp/translate';
import { translateDocx } from '../src/pipeline.js';
import { XcometMcpEvaluator } from '../src/xcomet-evaluator.js';

const models = (process.env.MODELS ?? 'aya-expanse:8b,tower-plus:9b,gemma4:latest')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const baseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1';
const targetLang = process.env.TARGET_LANG ?? 'en-GB';
const jsonMode = process.env.LLM_JSON_MODE !== 'false';
const [inPath = fixtureDocxPath] = process.argv.slice(2);

interface Row {
  model: string;
  avg: number;
  min: number;
  critical: number;
  translated: number;
  sec: number;
  error?: string;
}

console.error(`bench: models=[${models.join(', ')}] targetLang=${targetLang} in=${inPath}`);
const input = readFileSync(inPath);
const evaluator = new XcometMcpEvaluator({
  useGpu: process.env.XCOMET_USE_GPU === 'true',
});

const rows: Row[] = [];
try {
  for (const model of models) {
    console.error(`--- ${model} ---`);
    const t0 = Date.now();
    try {
      // model='deepl' を基準線として混在可能（要 DEEPL_API_KEY）
      const translator =
        model === 'deepl'
          ? new DeeplHttpTranslator(process.env.DEEPL_API_KEY ?? '')
          : new LlmTranslator({ model, baseUrl, jsonMode });
      const { dtir, stats } = await translateDocx(input, translator, {
        fileName: inPath,
        targetLang,
      });
      const segs = dtir.segments.filter((s) => s.translatable && s.translation);
      const evals = await evaluator.evaluateBatch(
        segs.map((s) => ({ source: s.text.source, translation: s.translation!.text })),
      );
      const scores = evals.map((e) => e.score);
      rows.push({
        model,
        avg: scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1),
        min: Math.min(...scores),
        critical: evals.filter((e) => e.hasCritical).length,
        translated: stats.translated,
        sec: (Date.now() - t0) / 1000,
      });
    } catch (e) {
      rows.push({
        model,
        avg: 0,
        min: 0,
        critical: 0,
        translated: 0,
        sec: (Date.now() - t0) / 1000,
        error: e instanceof Error ? e.message.split('\n')[0] : String(e),
      });
    }
  }
} finally {
  await evaluator.close();
}

rows.sort((a, b) => b.avg - a.avg);

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
console.log(`\n## モデル比較 — ${targetLang} / xCOMET\n`);
console.log('| モデル | 平均スコア | 最小スコア | critical | セグメント数 | 所要時間 |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const r of rows) {
  if (r.error) {
    console.log(`| ${r.model} | — | — | — | — | ${r.sec.toFixed(1)}s | ❌ ${r.error} |`);
  } else {
    console.log(
      `| ${r.model} | ${pct(r.avg)} | ${pct(r.min)} | ${r.critical} | ${r.translated} | ${r.sec.toFixed(1)}s |`,
    );
  }
}
