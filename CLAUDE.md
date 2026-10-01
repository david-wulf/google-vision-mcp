# CLAUDE.md — google-vision-mcp

## Zweck
Eigenbau-MCP-Server für die Google Cloud Vision API, zugeschnitten auf Bilder-SEO (Motiv, OCR, Stock-/Duplikat-Erkennung, Beschnitt für Discover/og:image). Liefert eine kompakte Auswertung je Bild statt Roh-Payload.

## Aufbau
- Einstieg: `src/index.ts` — Low-Level-`Server` mit `ListTools`/`CallTool`-Handlern, Key-Prüfung beim Start
- Logik: `src/vision.ts` — `FEATURES`, `AnalyzeImagesSchema` (zod), `annotateImages()` (lädt Bild selbst, Fallback: Google holt URL), `summarise()`, `siteOf()`, `formatMarkdown()`
- Tests: `src/vision.test.ts` (vitest)
- Herkunft/Git: Remotes: `forgejo` (`192.168.20.20:3000/davidwulf/google-vision-mcp`), `homeandsmart` (`homeandsmart-gmbh/google-vision-mcp`). Branch `main`.

## Tools
- `vision_analyze_images` — 1–16 Bild-URLs; Features `labels`, `objects`, `text`, `web`, `safe-search`, `faces`, `properties`, `crop-hints` (lesend, **kostenpflichtig**: je Bild × Feature, 1.000 Einheiten/Monat frei)

## Lokal starten & prüfen
```bash
npm install
npm run build        # tsc -> dist/
npm run typecheck
npm test             # vitest run
npm start            # node dist/index.js (bricht ohne Key mit Exit 1 ab)
```

## Einbindung in Claude
`~/.claude.json` (User-Scope) als `google-vision`: `node C:\Users\david\Claude-Code-Projekte\google-vision-mcp\dist\index.js` — ohne Wrapper; der Key wird laut README als Benutzer-Umgebungsvariable vom Claude-Prozess geerbt. Nach Änderungen `npm run build`, Claude neu starten.

## Konfiguration
- `GOOGLE_VISION_API_KEY` (Fallback `GOOGLE_API_KEY`) — Google-Cloud-Key mit aktivierter Vision API + Billing, möglichst auf `vision.googleapis.com` beschränkt
- optional `REQUEST_TIMEOUT` (ms, Standard 30000)

## Neues Tool hinzufügen
1. Logik + zod-Schema als Export in `src/vision.ts` (oder neues Modul daneben)
2. Tool-Objekt in das `tools`-Array des `ListToolsRequestSchema`-Handlers (`src/index.ts`) mit `inputSchema` und `annotations`
3. Im `CallToolRequestSchema`-Handler den Namen verzweigen (derzeit nur ein `if name !== …`), Eingabe per `safeParse`, Fehler als `isError: true` zurückgeben, Antwort als `content` + `structuredContent`
4. Test in `src/vision.test.ts` ergänzen (API per Mock, nicht live)

## Grenzen
- Key nie ins Repo, in Tests oder Logs (`.env` ist ignoriert).
- Jeder Aufruf kostet pro Bild und Feature: nur benötigte Features anfordern, Live-Tests mit wenigen Bildern und erst nach Freigabe.
- stdout gehört dem MCP-Protokoll — Diagnose nur auf stderr.
