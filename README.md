# google-vision-mcp

MCP-Server für die Google Cloud Vision API, zugeschnitten auf Bilder-SEO. Ein Tool:
`vision_analyze_images` — 1–16 Bild-URLs, kompakte Auswertung je Bild statt Roh-Payload.

| Feature | Liefert | Wofür |
|---|---|---|
| `labels` | Was Google im Bild sieht, mit Score | Denotation: passt das Bild zum Thema? |
| `objects` | Objekte mit Score und Flächenanteil | Hauptmotiv groß genug, Nebenobjekte |
| `text` | OCR-Wortzahl, Sprache, Auszug | Lesbarkeit von Verpackung/Overlay |
| `web` | Best Guess, Web-Entitäten, Treffer auf fremden Sites | Eigenbild oder Stock/Duplikat |
| `safe-search` | Likelihoods adult/racy/violence/… | Discover-Richtlinien |
| `faces` | Gesichter mit Emotions-Likelihoods | Wirkung gegen Creative Direction |
| `properties` | Dominante Farben | Kontrast, Markenfarben |
| `crop-hints` | Salienter Ausschnitt für 1.91:1, 16:9, 4:3, 1:1 | Übersteht das Motiv den Karten-Beschnitt? |

Standard: `labels`, `objects`, `text`, `web`. Abgerechnet wird je Bild und Feature
(1.000 Einheiten/Monat frei) — nur anfordern, was die Frage braucht.

Das Bild lädt der Server selbst und schickt die Bytes; nur wenn der Download scheitert, holt
Google die URL (das scheitert bei vielen Shops/CDNs still).

## Betrieb

```bash
npm install && npm run build && npm test
```

Key über `GOOGLE_VISION_API_KEY` (Fallback `GOOGLE_API_KEY`) — ein Google-Cloud-Key (`AIza…`)
aus einem Projekt mit aktivierter Cloud Vision API. In Claude Code über den Infisical-Wrapper
registriert, der Key liegt nie in einer Konfigurationsdatei:

```bash
claude mcp add -s user google-vision -- node C:\Users\david\.claude\infisical-run.mjs --project <infisical-projekt> --env dev --alias Google-API-Key:GOOGLE_VISION_API_KEY -- node C:\Users\david\Claude-Code-Projekte\google-vision-mcp\dist\index.js
```

Optional: `REQUEST_TIMEOUT` in ms (Standard 30000).
