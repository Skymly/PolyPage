# PolyPage

Manifest V3 browser translator extension (Chrome/Edge main line + Firefox MV3 MVP) built with TypeScript and an optional C#/.NET Native Messaging Host (`native-host/PolyPage.slnx`). Active specification: [`PolyPage-4.2.md`](PolyPage-4.2.md).

## Build & Verify

```bash
npm run verify          # typecheck + vitest + build + dotnet test native-host/PolyPage.slnx
npm run test:contract   # native gateway contract tests
npm run smoke           # Edge smoke check (requires ffmpeg)
npm run build:firefox
npm run firefox:gateway
```

- CI (`.github/workflows/ci.yml`, `.github/workflows/browser-validation.yml`) runs on Windows with Node 24 and .NET 8 / 10 SDKs.

## Architecture & Invariants

- **ADRs & domain terms**: Follow [`CONTEXT.md`](CONTEXT.md) and [`docs/adr/`](docs/adr/) (0001 translation pipeline, 0002 OCR roundtrip, 0003 page translation, 0004 ASR roundtrip, 0005 provider capabilities).
- **Protocol & schema alignment**: Keep settings `schemaVersion`, extension message protocol version, and the .NET gateway `ProtocolVersion` aligned across TypeScript and C#.
- **Translation hygiene**: Strip model thinking tags (e.g. `<think>`) consistently and treat empty stripped results as failures rather than writing them into cache/TM.

## Docs & Agent Config

- Domain glossary: [`CONTEXT.md`](CONTEXT.md)
- ADRs & specs: [`docs/adr/`](docs/adr/), [`PolyPage-4.2.md`](PolyPage-4.2.md)

## Conventions

- Commit messages, issues, and PR text: **English**.
- Do not commit or push unless explicitly requested.
