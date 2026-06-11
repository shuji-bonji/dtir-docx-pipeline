/**
 * cli — 入力 docx → 訳 docx を出力するヘッドレス CLI（Phase 1 / Phase 2）
 *
 * 使い方:
 *   LLM_MODEL=tower-plus:9b LLM_BASE_URL=http://neko8.local:11434/v1 \
 *     npx tsx src/cli.ts <input.docx> <output.docx>
 *
 *   引数省略時は doc-translation-ir 同梱フィクスチャを入力に
 *   ./output.<TARGET_LANG>.docx へ出力する（受け入れ条件の検証用）。
 *
 * env:
 *   LLM_MODEL           既定 aya-expanse:8b
 *   LLM_BASE_URL        既定 http://localhost:11434/v1
 *   TARGET_LANG         既定 en-GB
 *   LLM_JSON_MODE       "false" で JSON モード無効（非対応モデル向け）
 *
 *   XCOMET_GATE         "1" で Phase 2 品質ゲート＋再翻訳ループを有効化
 *   XCOMET_PYTHON_PATH  venv の python（例 ~/.xcomet-venv/bin/python3）
 *   XCOMET_SERVER_ENTRY xcomet-mcp-server/dist/index.js（既定: sibling 解決）
 *   XCOMET_THRESHOLD    再翻訳閾値。既定 0.6
 *   XCOMET_MAX_ROUNDS   再翻訳ラウンド上限。既定 2
 *   XCOMET_USE_GPU      "true" で GPU(MPS) 推論
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fixtureDocxPath } from '@shuji-bonji/doc-translation-ir/fixtures';
import { LlmTranslator } from '@shuji-bonji/dtir-translate-mcp/translate';
import {
  translateDocx,
  translateDocxWithGate,
  type TranslateDocxResult,
  type TranslateDocxWithGateResult,
} from './pipeline.js';
import { XcometMcpEvaluator } from './xcomet-evaluator.js';

const model = process.env.LLM_MODEL ?? 'aya-expanse:8b';
const baseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1';
const targetLang = process.env.TARGET_LANG ?? 'en-GB';
const jsonMode = process.env.LLM_JSON_MODE !== 'false';
const useGate = process.env.XCOMET_GATE === '1';

const [inPath = fixtureDocxPath, outPath = `./output.${targetLang}.docx`] =
  process.argv.slice(2);

console.error(`model=${model} baseUrl=${baseUrl} targetLang=${targetLang} gate=${useGate}`);
console.error(`in=${inPath}`);

const translator = new LlmTranslator({ model, baseUrl, jsonMode });
const input = readFileSync(inPath);
const started = Date.now();

let result: TranslateDocxResult | TranslateDocxWithGateResult;
if (useGate) {
  const evaluator = new XcometMcpEvaluator({
    useGpu: process.env.XCOMET_USE_GPU === 'true',
  });
  try {
    result = await translateDocxWithGate(input, translator, evaluator, {
      fileName: inPath,
      targetLang,
      threshold: Number(process.env.XCOMET_THRESHOLD ?? 0.6),
      maxRounds: Number(process.env.XCOMET_MAX_ROUNDS ?? 2),
    });
  } finally {
    await evaluator.close();
  }
} else {
  result = await translateDocx(input, translator, { fileName: inPath, targetLang });
}

writeFileSync(outPath, result.docx);

const sec = ((Date.now() - started) / 1000).toFixed(1);
const { dtir, stats } = result;
const langs = dtir.language.multilingual?.languagesPresent?.join(',') ?? '(n/a)';
console.error(
  `out=${outPath} translated=${stats.translated} batchCalls=${stats.batchCalls} langs=${langs} time=${sec}s`,
);
if ('gate' in result) {
  const last = result.gate.rounds[result.gate.rounds.length - 1];
  console.error(
    `gate: rounds=${result.gate.rounds.length} avg=${last?.averageScore} ` +
      `remainingFailing=${result.gate.remainingFailing.length}` +
      (result.gate.remainingFailing.length > 0
        ? ` [${result.gate.remainingFailing.join(',')}]`
        : ''),
  );
}
