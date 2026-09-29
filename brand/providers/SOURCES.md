# Provider marks

Monochrome vendor marks, rendered as template images tinted by the app.
All sources are MIT licensed.

## lobe-icons static set

Package `@lobehub/icons-static-svg` 1.95.0, MIT.
Base URL: `https://unpkg.com/@lobehub/icons-static-svg@1.95.0/icons/<name>.svg`

| File              | Source name    |
| ----------------- | -------------- |
| openai.svg        | openai         |
| github-copilot.svg | githubcopilot |
| zai.svg           | zai            |
| moonshot.svg      | moonshot       |
| alibaba.svg       | qwen           |
| minimax.svg       | minimax        |
| anthropic.svg     | anthropic      |
| google.svg        | google         |
| xai.svg           | xai            |
| deepseek.svg      | deepseek       |
| openrouter.svg    | openrouter     |
| vercel.svg        | vercel         |
| cloudflare.svg    | cloudflare     |
| ollama.svg        | ollama         |
| lmstudio.svg      | lmstudio       |

## opencode provider icons

Repo `anomalyco/opencode`, `packages/ui/src/components/provider-icons/sprite.svg`
(`dev` branch, fetched Sep 2026), MIT. Each `<symbol>` was extracted to a
standalone SVG with its own viewBox.

| File           | Symbol id   |
| -------------- | ----------- |
| opencode.svg   | opencode    |
| opencode-go.svg | opencode-go |
| xiaomi.svg     | xiaomi      |

## Command Code

`command-code.svg` is the site's own mask icon,
`https://commandcode.ai/favicon/2024/safari-pinned-tab.svg` (fetched Sep 2026),
with the potrace metadata and fixed size removed.

## No mark

`custom` has no vendored mark. The app falls back to the
monogram tile when `brand/providers/<icon>.svg` is missing.
