/**
 * live-deepl-runs — 実 DeepL で inlineFormatting:'runs'（脱collapse）を実機確認する手動スクリプト
 *
 * モックでは「エンジンが <x id> タグを訳語スパンへ移動して返す」と仮定していた部分を、
 * **本物の DeepL（tag_handling=xml）で検証**する。複数ラン段落（torture フィクスチャの
 * 太字・ハイパーリンク・追跡変更・脚注参照文）について:
 *   - reader が送るマークアップ
 *   - DeepL が返した生テキスト（タグがどう動いたか）
 *   - parseRunsMarkup の復元結果（runTexts）/ 復元失敗で collapse フォールバックか
 * を表で出し、最後に訳 docx を書き出す（Word で開いて書式保持を目視できる）。
 *
 * 実行（キーはチャットに貼らず、お手元の環境変数で）:
 *   DEEPL_API_KEY=xxxxxxxx:fx TARGET_LANG=en-GB \
 *     npx tsx test/live-deepl-runs.ts ./out.runs.docx
 *
 *   Free キーは末尾 ":fx"（api-free へ自動判定）、Pro は ":fx" 無し。
 *   DEEPL_API_URL を明示すればそれが優先。
 *
 * 注意: 本スクリプトは npm test に含めない（実 API・課金・ネットワークが要るため手動実行）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { docxToDtir } from '@shuji-bonji/dtir-ooxml-reader-mcp/reader';
import { dtirToDocx } from '@shuji-bonji/dtir-ooxml-writer-mcp/writer';
import {
  DeeplHttpTranslator,
  translateDtir,
  type TranslateBatchOptions,
  type Translator,
} from '@shuji-bonji/dtir-translate-mcp/translate';
import { tortureDocxPath } from '@shuji-bonji/doc-translation-ir/fixtures';

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** DeepL をラップして markup バッチの入出力を記録する（実機の生挙動を見るため）。 */
class LoggingDeepl implements Translator {
  public marked: { input: string[]; output: string[] }[] = [];
  constructor(private readonly inner: DeeplHttpTranslator) {}
  async translateBatch(texts: string[], opts: TranslateBatchOptions): Promise<string[]> {
    const out = await this.inner.translateBatch(texts, opts);
    if (opts.markup) this.marked.push({ input: texts, output: out });
    return out;
  }
}

async function docXml(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return (await zip.file('word/document.xml')?.async('string')) ?? '';
}

async function main(): Promise<void> {
  const key = process.env.DEEPL_API_KEY;
  if (!key) {
    console.error('DEEPL_API_KEY が未設定です（お手元の環境変数で渡してください）');
    process.exit(2);
  }
  const targetLang = process.env.TARGET_LANG ?? 'en-GB';
  const outPath = process.argv[2] ?? './out.runs.docx';

  const orig = readFileSync(tortureDocxPath);
  const dtir = await docxToDtir(orig, { fileName: 'work-doc-torture.docx', targetLang });
  const translator = new LoggingDeepl(
    new DeeplHttpTranslator(key, process.env.DEEPL_API_URL),
  );

  const { stats } = await translateDtir(dtir, translator, {
    targetLang,
    engineName: 'deepl',
    inlineFormatting: 'runs',
  });

  console.error(`\n=== DeepL が返した markup バッチ（tag_handling=xml の生挙動）===`);
  for (const b of translator.marked) {
    b.input.forEach((inp, i) => {
      console.error(DIM('  送信: ') + inp);
      console.error(DIM('  受信: ') + b.output[i]);
    });
  }

  console.error(`\n=== 複数ラン段落の復元結果 ===`);
  let preserved = 0;
  let fallback = 0;
  for (const s of dtir.segments) {
    if (!s.text.runs || s.text.runs.length <= 1 || !s.translation) continue;
    if (s.translation.runTexts) {
      preserved++;
      console.error(GREEN(`  [runs] `) + JSON.stringify(s.text.source));
      console.error(`         → ${JSON.stringify(s.translation.runTexts)}`);
    } else {
      fallback++;
      console.error(RED(`  [collapse fallback] `) + JSON.stringify(s.text.source));
      console.error(`         → ${JSON.stringify(s.translation.text)}（タグ復元できず collapse）`);
    }
  }

  const out = await dtirToDocx(dtir, orig, { onMissingTranslation: 'keep' });
  writeFileSync(outPath, out);
  const xml = await docXml(out);
  const boldKept = /<w:rPr>\s*<w:b\/>\s*<\/w:rPr>\s*<w:t[^>]*>[^<]+<\/w:t>/.test(xml);
  const linkKept = xml.includes('<w:hyperlink');

  console.error(`\n=== 出力 docx の書式保持チェック ===`);
  console.error(`  太字ラン保持: ${boldKept ? GREEN('YES') : RED('NO')}`);
  console.error(`  ハイパーリンク保持: ${linkKept ? GREEN('YES') : RED('NO')}`);
  console.error(
    `\nstats: translated=${stats.translated} batchCalls=${stats.batchCalls} chunked=${stats.chunked}`,
  );
  console.error(`複数ラン段落: 書式保持=${preserved} / collapseフォールバック=${fallback}`);
  console.error(`out=${outPath}（Word で開いて太字・リンクの表示を目視確認してください）`);
  console.error(
    preserved > 0 && boldKept
      ? GREEN('\nLIVE RUNS: DeepL tag_handling で段内書式が保持されました')
      : RED('\nLIVE RUNS: 保持できた段落がありません（モデル/タグ挙動を要確認）'),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
