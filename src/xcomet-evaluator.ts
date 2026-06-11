/**
 * xcomet-evaluator — xcomet-mcp-server を MCP クライアント(stdio)として呼ぶ Evaluator
 *
 * Phase 2 の品質ゲート。xcomet-mcp-server は Node 製 MCP サーバで、内部の
 * Python ワーカー（venv + unbabel-comet）に xCOMET 推論を委譲する。
 * 本クラスは server を子プロセスとして spawn し、tool を呼ぶだけ。
 *
 * - `evaluate()`  : translateDtir の Evaluator 契約（単発・エラー位置つき）
 * - `evaluateBatch()`: xcomet_batch_evaluate（モデル常駐でペア列を一括採点）
 *   再翻訳ループはこちらを使う（CPU 推論は1ペア数秒のため単発の逐次は遅い）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Evaluator, EvalResult } from '@shuji-bonji/dtir-translate-mcp/translate';

export interface XcometMcpEvaluatorOptions {
  /** xcomet-mcp-server のエントリ（dist/index.js の絶対パス）。既定: sibling 配置を解決。 */
  serverEntry?: string;
  /** venv の python。xcomet-mcp-server の XCOMET_PYTHON_PATH に渡す。 */
  pythonPath?: string;
  /** 既定 Unbabel/XCOMET-XL（server 側の既定に従う）。 */
  model?: string;
  /** GPU(MPS) 推論。既定 false。 */
  useGpu?: boolean;
  /** batch_size 1-64。既定 8。 */
  batchSize?: number;
}

/** sibling 配置（mcps/ 直下に並ぶ前提）の xcomet-mcp-server を解決。 */
const defaultServerEntry = () =>
  new URL('../../xcomet-mcp-server/dist/index.js', import.meta.url).pathname;

interface XcometSingleResponse {
  score: number;
  errors?: { text: string; start: number; end: number; severity: string }[];
  summary?: string;
}

export interface XcometBatchItem {
  score: number;
  hasCritical: boolean;
  errorCount: number;
}

export class XcometMcpEvaluator implements Evaluator {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly useGpu: boolean;
  private readonly batchSize: number;
  private connected = false;

  constructor(opts: XcometMcpEvaluatorOptions = {}) {
    this.useGpu = opts.useGpu ?? false;
    this.batchSize = opts.batchSize ?? 8;
    this.client = new Client({ name: 'dtir-docx-pipeline', version: '0.0.1' });
    this.transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [opts.serverEntry ?? process.env.XCOMET_SERVER_ENTRY ?? defaultServerEntry()],
      env: {
        ...getDefaultEnvironment(),
        ...(opts.pythonPath ?? process.env.XCOMET_PYTHON_PATH
          ? { XCOMET_PYTHON_PATH: opts.pythonPath ?? process.env.XCOMET_PYTHON_PATH! }
          : {}),
        ...(opts.model ? { XCOMET_MODEL: opts.model } : {}),
      },
      stderr: 'inherit', // server のログ（モデルロード進捗等）を素通し
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  private parseText<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
    const content = result.content as { type: string; text?: string }[];
    const text = content?.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error('xcomet-mcp: text コンテンツが空');
    return JSON.parse(text) as T;
  }

  /** Evaluator 契約（単発）。エラー位置つきで quality を充填できる。 */
  async evaluate(source: string, translation: string): Promise<EvalResult> {
    await this.connect();
    const r = await this.client.callTool({
      name: 'xcomet_evaluate',
      arguments: { source, translation, response_format: 'json', use_gpu: this.useGpu },
    });
    const j = this.parseText<XcometSingleResponse>(r);
    const errors = (j.errors ?? []).map((e) => ({
      text: e.text,
      start: e.start,
      end: e.end,
      severity: e.severity as EvalResult['errors'][number]['severity'],
    }));
    return {
      score: j.score,
      hasCritical: errors.some((e) => e.severity === 'critical'),
      errors,
    };
  }

  /** ペア列の一括採点（モデル常駐・再翻訳ループ用）。入力順で返す。 */
  async evaluateBatch(
    pairs: { source: string; translation: string }[],
  ): Promise<XcometBatchItem[]> {
    if (pairs.length === 0) return [];
    await this.connect();
    const r = await this.client.callTool({
      name: 'xcomet_batch_evaluate',
      arguments: {
        pairs,
        response_format: 'json',
        use_gpu: this.useGpu,
        batch_size: this.batchSize,
      },
    });
    const j = this.parseText<{
      average_score: number;
      results: { index: number; score: number; error_count: number; has_critical_errors: boolean }[];
    }>(r);
    const out: XcometBatchItem[] = new Array(pairs.length);
    for (const item of j.results) {
      out[item.index] = {
        score: item.score,
        hasCritical: item.has_critical_errors,
        errorCount: item.error_count,
      };
    }
    return out;
  }
}
