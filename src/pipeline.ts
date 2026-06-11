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
  chunkBySegments,
  DEFAULT_BATCH_LIMITS,
  type BatchLimits,
  type Evaluator,
  type Translator,
  type TranslateStats,
} from '@shuji-bonji/dtir-translate-mcp/translate';
import type { IRDocument, IRSegment } from '@shuji-bonji/doc-translation-ir';

export interface TranslateDocxOptions {
  fileName?: string;
  targetLang: string;
  /** 指定すると各セグメントの quality を xCOMET 等で充填。 */
  evaluator?: Evaluator;
  /** 未翻訳セグメントの扱い（既定 keep=原文維持）。 */
  onMissingTranslation?: 'keep' | 'error';
  /** バッチのサイズ上限（長文の単一巨大バッチを防ぐ。既定 DEFAULT_BATCH_LIMITS）。 */
  limits?: BatchLimits;
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
    limits: options.limits,
  });
  const out = await dtirToDocx(dtir, docx, {
    onMissingTranslation: options.onMissingTranslation ?? 'keep',
  });
  return { docx: out, dtir, stats };
}

// ---------------------------------------------------------------------------
// Phase 2 — xCOMET 品質ゲート＋部分再翻訳ループ
// ---------------------------------------------------------------------------

/**
 * バッチ採点できる Evaluator（xcomet_batch_evaluate）。
 * XcometMcpEvaluator が構造的に満たす。CPU 推論は1ペア数秒かかるため、
 * ゲートは単発 evaluate の逐次ではなくこちらを使う。
 */
export interface BatchEvaluator {
  evaluateBatch(
    pairs: { source: string; translation: string }[],
  ): Promise<{ score: number; hasCritical: boolean }[]>;
}

export interface QualityGateOptions {
  fileName?: string;
  targetLang: string;
  /** これ未満のスコアは再翻訳対象。既定 0.6。 */
  threshold?: number;
  /** 再翻訳ラウンド上限。既定 2。 */
  maxRounds?: number;
  onMissingTranslation?: 'keep' | 'error';
  /** バッチのサイズ上限（初回翻訳・再翻訳の両方に適用。既定 DEFAULT_BATCH_LIMITS）。 */
  limits?: BatchLimits;
  /** ラウンドごとのログ（既定 console.error）。 */
  log?: (line: string) => void;
}

export interface GateRoundLog {
  /** 0=初回採点、1..=再翻訳ラウンド。 */
  round: number;
  evaluated: number;
  averageScore: number;
  failing: number;
  critical: number;
  /** 再翻訳ラウンドで訳が改善・採用されたセグメント数（round 0 では 0）。 */
  adopted: number;
}

export interface TranslateDocxWithGateResult extends TranslateDocxResult {
  gate: {
    rounds: GateRoundLog[];
    /** 全ラウンド後も閾値未満のまま残ったセグメント id。 */
    remainingFailing: string[];
  };
}

const isFailing = (s: IRSegment, threshold: number): boolean =>
  s.quality != null && (s.quality.score < threshold || s.quality.hasCritical);

/**
 * translateDocx の品質ゲート版（固定 DAG: read→translate→evaluate→retry*→write）。
 *
 * 1. 全 translatable を翻訳（translateDtir）
 * 2. xCOMET で一括採点し各セグメントの quality を充填
 * 3. score < threshold または critical のセグメントだけ再翻訳→再採点し、
 *    **改善した場合のみ採用**（劣化したら旧訳を保持）
 * 4. maxRounds で打ち切り。残った低品質セグメントは gate.remainingFailing に記録
 *
 * 再翻訳ループはこの orchestrator 層に置き、translate-mcp は変更しない。
 */
export async function translateDocxWithGate(
  docx: Buffer,
  translator: Translator,
  evaluator: BatchEvaluator,
  options: QualityGateOptions,
): Promise<TranslateDocxWithGateResult> {
  const threshold = options.threshold ?? 0.6;
  const maxRounds = options.maxRounds ?? 2;
  const limits = options.limits ?? DEFAULT_BATCH_LIMITS;
  const log = options.log ?? ((line: string) => console.error(line));

  // read → translate（全 translatable を1回翻訳。採点は分離してバッチで行う）
  const dtir = await docxToDtir(docx, {
    fileName: options.fileName,
    targetLang: options.targetLang,
  });
  const { stats } = await translateDtir(dtir, translator, {
    targetLang: options.targetLang,
    limits,
  });

  const translatedSegs = dtir.segments.filter(
    (s): s is IRSegment & { translation: NonNullable<IRSegment['translation']> } =>
      s.translatable && s.translation != null,
  );

  // round 0 — 全セグメントを一括採点
  const rounds: GateRoundLog[] = [];
  const scoreAll = async (segs: typeof translatedSegs, round: number, adopted: number) => {
    const results = await evaluator.evaluateBatch(
      segs.map((s) => ({ source: s.text.source, translation: s.translation.text })),
    );
    segs.forEach((s, i) => {
      s.quality = { score: results[i].score, hasCritical: results[i].hasCritical, errors: [] };
    });
    const failing = translatedSegs.filter((s) => isFailing(s, threshold));
    const avg =
      translatedSegs.reduce((a, s) => a + (s.quality?.score ?? 0), 0) /
      Math.max(translatedSegs.length, 1);
    const entry: GateRoundLog = {
      round,
      evaluated: segs.length,
      averageScore: Number(avg.toFixed(4)),
      failing: failing.length,
      critical: translatedSegs.filter((s) => s.quality?.hasCritical).length,
      adopted,
    };
    rounds.push(entry);
    log(
      `[gate] round=${round} evaluated=${entry.evaluated} avg=${entry.averageScore} ` +
        `failing=${entry.failing} critical=${entry.critical} adopted=${entry.adopted}`,
    );
    return failing;
  };

  let failing = await scoreAll(translatedSegs, 0, 0);

  // retry — 低品質セグメントだけ group(=source言語) ごとに再翻訳し、改善時のみ採用
  for (let round = 1; round <= maxRounds && failing.length > 0; round++) {
    const byGroup = new Map<string, typeof failing>();
    for (const s of failing) {
      const key = s.group ?? '';
      (byGroup.get(key) ?? byGroup.set(key, []).get(key)!).push(s);
    }

    let adopted = 0;
    for (const [group, segs] of byGroup) {
      const sourceLang = group === '' ? null : group;
      // 再翻訳もサイズ上限でチャンク化（初回翻訳と同じ境界・順序保持）。
      const candidates: string[] = [];
      for (const chunk of chunkBySegments(segs, limits)) {
        const out = await translator.translateBatch(
          chunk.map((s) => s.text.source),
          { sourceLang, targetLang: options.targetLang },
        );
        if (out.length !== chunk.length) {
          throw new Error(
            `境界破壊(retry): 入力 ${chunk.length} 件に対し戻り ${out.length} 件（group=${group}）`,
          );
        }
        candidates.push(...out);
      }
      const evals = await evaluator.evaluateBatch(
        segs.map((s, i) => ({ source: s.text.source, translation: candidates[i] })),
      );
      segs.forEach((s, i) => {
        const oldScore = s.quality?.score ?? 0;
        const oldCritical = s.quality?.hasCritical ?? false;
        const better =
          evals[i].score > oldScore || (oldCritical && !evals[i].hasCritical);
        if (better) {
          s.translation = {
            ...s.translation,
            text: candidates[i],
            at: new Date().toISOString(),
          };
          s.quality = { score: evals[i].score, hasCritical: evals[i].hasCritical, errors: [] };
          adopted++;
        }
      });
    }

    failing = translatedSegs.filter((s) => isFailing(s, threshold));
    rounds.push({
      round,
      evaluated: failing.length,
      averageScore: Number(
        (
          translatedSegs.reduce((a, s) => a + (s.quality?.score ?? 0), 0) /
          Math.max(translatedSegs.length, 1)
        ).toFixed(4),
      ),
      failing: failing.length,
      critical: translatedSegs.filter((s) => s.quality?.hasCritical).length,
      adopted,
    });
    const r = rounds[rounds.length - 1];
    log(
      `[gate] round=${round} avg=${r.averageScore} failing=${r.failing} ` +
        `critical=${r.critical} adopted=${r.adopted}`,
    );
  }

  if (failing.length > 0) {
    log(`[gate] 打ち切り: ${failing.length} セグメントが閾値 ${threshold} 未満のまま`);
  }

  const out = await dtirToDocx(dtir, docx, {
    onMissingTranslation: options.onMissingTranslation ?? 'keep',
  });
  return {
    docx: out,
    dtir,
    stats,
    gate: { rounds, remainingFailing: failing.map((s) => s.id) },
  };
}
