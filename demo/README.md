**日本語** | [English](./README.en.md)

# demo — 翻訳パイプラインのデモ入力と検証手順

混在言語 `.docx` を、書式・表・目次・画像を崩さずに翻訳する end-to-end の動作確認用。

## デモ入力

| ファイル | 内容 |
| --- | --- |
| `mixed_language_sensor_manual.docx` | **実務寄りのサンプル**。英独混在のセンサ取扱説明書（日本語タイトル＋ EN/DE 段落＋仕様表＋箇条書き）。`<w:lang>` タグを持たない＝**言語検出パスをそのまま検証**できる。`Authentication Token` / `API endpoint` / `Firmware` 等の用語が反復し、**glossary（用語一貫性）の検証に好適**。32 セグメント・表セル12（再帰走査で取得）。 |
| `glossary.sample.json` | 上記サンプル用の用語集サンプル（target=ja）。`bySource` に en/de の用語対。 |
| その他 `*.docx` / `*.pdf` | 過去の翻訳出力（参考）。 |

> このサンプルは元々 python-docx スクリプト（`create_sample.py`）で生成していたが、**成果物の docx をそのまま同梱**することにした（python-docx 依存と「誰も再実行しない生成ステップ」を抱えないため）。生成ロジックが必要なら git 履歴を参照。

## 前提（依存パッケージのビルド）

pipeline は reader/translate/writer の **dist** を消費する。初回・更新時はビルドしておく。

```sh
for d in dtir-ooxml-reader-mcp dtir-ooxml-writer-mcp dtir-translate-mcp; do
  (cd ../../$d && npm run build)
done
```

## 検証コマンド（CLI = a-3 / b-3）

`dtir-docx-pipeline/` 直下で実行。

### DeepL で翻訳（a-3）

```sh
# キーはお手元の環境変数で。Free は末尾 ":fx"、Pro は無し（自動判定）
DEEPL_API_KEY='xxxx:fx' TARGET_LANG=ja \
  npx tsx src/cli.ts demo/mixed_language_sensor_manual.docx demo/manual.ja.docx
```

### ローカルLLM で翻訳（b-3 / Ollama）

```sh
LLM_MODEL=tower-plus:9b LLM_BASE_URL=http://<host>:11434/v1 TARGET_LANG=ja \
  npx tsx src/cli.ts demo/mixed_language_sensor_manual.docx demo/manual.ja.docx
```

### 用語集（glossary）を効かせる

```sh
# LLM はプロンプト注入で即効く。DeepL は deeplIds(事前作成した glossary_id) が必要
LLM_MODEL=tower-plus:9b LLM_BASE_URL=http://<host>:11434/v1 TARGET_LANG=ja \
GLOSSARY_PATH=demo/glossary.sample.json \
  npx tsx src/cli.ts demo/mixed_language_sensor_manual.docx demo/manual.ja.glossary.docx
```

### 段内書式を保持する（脱collapse / runs モード）

```sh
# 太字・色・リンクをラン別に保持。DeepL 推奨（tag_handling=xml）。
# 復元に失敗した段落は自動で collapse にフォールバック（fail-safe）。
DEEPL_API_KEY='xxxx:fx' TARGET_LANG=ja INLINE_FORMATTING=runs \
  npx tsx src/cli.ts demo/mixed_language_sensor_manual.docx demo/manual.ja.runs.docx
```

## 構造の機械検証（壊れていないことの確認）

訳 docx を再 reader にかけ、`validateDtir` が空・元 docx とセグメント id 集合が一致することを確認する。

```sh
npx tsx src/verify.ts demo/manual.ja.docx demo/mixed_language_sensor_manual.docx
```

Word 互換（LibreOffice で PDF 化できる）も見たい場合:

```sh
soffice --headless --convert-to pdf --outdir demo demo/manual.ja.docx
```

## Claude Desktop / MCP 経路（a-2 / b-2）

会話駆動で使う場合は 3 つの MCP（`docx_to_dtir` → `translate_dtir` → `dtir_to_docx`）を順に呼ぶ。
docx は base64 で受け渡す（`base64 -w0 demo/mixed_language_sensor_manual.docx`）。
`translate_dtir` の引数で `engine`（deepl/llm）・`glossaryJson`・`inlineFormatting:"runs"` を切り替えられる。
詳細は [`docs/cloud-llm-usage.md`](../docs/cloud-llm-usage.md) を参照。
