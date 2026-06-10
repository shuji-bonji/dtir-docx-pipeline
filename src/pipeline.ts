/**
 * pipeline — reader → translate → writer の配線（混在言語 docx の翻訳一気通貫）
 *
 * 3つの MCP パッケージのライブラリ API を束ねた、唯一「全部に依存する」場所。
 * 翻訳エンジンは Translator 抽象で差し替え可（DeepL / ローカル LLM / 静的マップ）。
 * 将来この関数を LangGraph の StateGraph ノードから呼ぶ（決定論オーケストレーション）。
 */
import { docxToDtir } from '@shuji-bonji/dtir-ooxml-reader-mcp/reader';
import { dtirToDocx } from '@shuji-bonji/dtir-ooxml-writer-mcp/writer';
import {
  translateDtir,
  type Evaluator,
  type Translator,
  type TranslateStats,
} from '@shuji-bonji/dtir-translate-mcp/translate';
import type { IRDocument } from '@shuji-bonji/doc-translation-ir';

export interface TranslateDocxOptions {
  fileName?: string;
  targetLang: string;
  /** 指定すると各セグメントの quality を xCOMET 等で充填。 */
  evaluator?: Evaluator;
  /** 未翻訳セグメントの扱い（既定 keep=原文維持）。 */
  onMissingTranslation?: 'keep' | 'error';
}

export interface TranslateDocxResult {
  /** 訳 docx。 */
  docx: Buffer;
  /** 翻訳済み DTIR（監査・再利用用）。 */
  dtir: IRDocument;
  stats: TranslateStats;
}

/**
 * 混在言語 docx を、Translator で翻訳して訳 docx を返す。
 * reader が書式・画像・sectPr を anchor に隠し、writer が id でパッチするため、
 * 構造は保持される。
 */
export async function translateDocx(
  docx: Buffer,
  translator: Translator,
  options: TranslateDocxOptions,
): Promise<TranslateDocxResult> {
  const dtir = await docxToDtir(docx, {
    fileName: options.fileName,
    targetLang: options.targetLang,
  });
  const { stats } = await translateDtir(dtir, translator, {
    targetLang: options.targetLang,
    evaluator: options.evaluator,
  });
  const out = await dtirToDocx(dtir, docx, {
    onMissingTranslation: options.onMissingTranslation ?? 'keep',
  });
  return { docx: out, dtir, stats };
}
