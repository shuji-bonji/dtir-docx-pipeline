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
 *   ENGINE              'deepl' | 'llm'（省略時: DEEPL_API_KEY があれば deepl=a-3、無ければ llm=b-3）
 *   DEEPL_API_KEY       engine=deepl 用の DeepL キー（DEEPL_API_URL で Pro 切替）
 *   GLOSSARY_PATH       用語集 Glossary JSON のパス（任意）。LLM はプロンプト注入、
 *                       DeepL は deeplIds の glossary_id を source 言語別に適用
 *   BATCH_MAX_ITEMS     1バッチの最大セグメント数（既定 deepl=50 / llm=20）
 *   BATCH_MAX_CHARS     1バッチの最大合計文字数（既定 deepl=120000 / llm=4000）
 *   INLINE_FORMATTING   'collapse'（既定）| 'runs'（段内の太字・色・リンクを保持）
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
import {
  DeeplHttpTranslator,
  LlmTranslator,
  type Glossary,
  type Translator,
} from '@shuji-bonji/dtir-translate-mcp/translate';
import type { BatchLimits } from '@shuji-bonji/dtir-translate-mcp/translate';
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
const inlineFormatting = process.env.INLINE_FORMATTING === 'runs' ? 'runs' : 'collapse';
// エンジン選択: ENGINE 明示、なければ DEEPL_API_KEY があれば deepl(a-3)、無ければ llm(b-3)
const engine = process.env.ENGINE ?? (process.env.DEEPL_API_KEY ? 'deepl' : 'llm');

const [inPath = fixtureDocxPath, outPath = `./output.${targetLang}.docx`] =
  process.argv.slice(2);

console.error(
  engine === 'deepl'
    ? `engine=deepl targetLang=${targetLang} gate=${useGate}`
    : `engine=llm model=${model} baseUrl=${baseUrl} targetLang=${targetLang} gate=${useGate}`,
);
console.error(`in=${inPath}`);

if (engine === 'deepl' && !process.env.DEEPL_API_KEY) {
  console.error('engine=deepl だが DEEPL_API_KEY が未設定です');
  process.exit(2);
}
// 用語集（任意）: GLOSSARY_PATH の JSON を読み込み、両エンジンへ適用。
const glossary: Glossary | undefined = process.env.GLOSSARY_PATH
  ? (JSON.parse(readFileSync(process.env.GLOSSARY_PATH, 'utf8')) as Glossary)
  : undefined;
if (glossary) console.error(`glossary=${process.env.GLOSSARY_PATH}`);
// サイズ上限: 明示 env > エンジン別プリセット（LLM はコンテキストが狭いので小さめ）。
const limitPreset: BatchLimits =
  engine === 'deepl' ? { maxItems: 50, maxChars: 120_000 } : { maxItems: 20, maxChars: 4_000 };
const limits: BatchLimits = {
  maxItems: process.env.BATCH_MAX_ITEMS ? Number(process.env.BATCH_MAX_ITEMS) : limitPreset.maxItems,
  maxChars: process.env.BATCH_MAX_CHARS ? Number(process.env.BATCH_MAX_CHARS) : limitPreset.maxChars,
};
const translator: Translator =
  engine === 'deepl'
    ? new DeeplHttpTranslator(process.env.DEEPL_API_KEY!, process.env.DEEPL_API_URL, glossary)
    : new LlmTranslator({ model, baseUrl, jsonMode, glossary });
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
      limits,
      inlineFormatting,
    });
  } finally {
    await evaluator.close();
  }
} else {
  result = await translateDocx(input, translator, {
    fileName: inPath,
    targetLang,
    limits,
    inlineFormatting,
  });
}

writeFileSync(outPath, result.docx);

const sec = ((Date.now() - started) / 1000).toFixed(1);
const { dtir, stats } = result;
const langs = dtir.language.multilingual?.languagesPresent?.join(',') ?? '(n/a)';
console.error(
  `out=${outPath} translated=${stats.translated} batchCalls=${stats.batchCalls} chunked=${stats.chunked} langs=${langs} time=${sec}s`,
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
