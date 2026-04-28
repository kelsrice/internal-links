# Link Opportunities — Semantic Internal Link Suggestions

A Chrome extension that suggests relevant internal links as you write. Highlight anchor text in your CMS, get ranked suggestions from your site's page index, and copy the URL — without leaving the editor.

Works in WordPress, Contentful, Google Docs, and any browser-based CMS.

---

## How it works

1. Export a CSV of your site's pages (URL + Title + Meta Description) from Screaming Frog, Ahrefs, or Google Search Console.
2. The extension generates embeddings for each page using the OpenAI API and stores them locally in your browser (IndexedDB). The import runs in the background — you can close the popup safely while it's running.
3. Highlight anchor text and trigger the sidebar. The extension embeds that text and finds the most semantically similar pages in your index.
4. Optional signals layer on top: traffic and conversion data surface pages that are both relevant and high-value; internal link counts boost underlinked pages.

All data stays local — no backend, no server, no data sent anywhere except OpenAI for embedding.

---

## Requirements

- Google Chrome (or any Chromium-based browser)
- An [OpenAI API key](https://platform.openai.com/api-keys)
- A CSV export of your site's pages (instructions below)

---

## Installation

1. Download or clone this repository
2. In Chrome, go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the extension folder from this repo
6. The 🔗 button will appear in the bottom-right corner of any page

---

## Setup

### 1. Add your OpenAI API key

Click the extension icon in the Chrome toolbar → paste your API key → it saves automatically.

### 2. Prepare your pages CSV

Export a CSV from any SEO tool with the following columns. Column names are auto-detected, so exact naming doesn't matter as long as they're recognizable.

| Column | Required | Notes |
|---|---|---|
| URL / Address | ✅ Required | Full page URLs |
| Title | Recommended | Page title tag. If absent, the URL slug is used. |
| Meta Description | Optional | Improves semantic matching quality |
| H2 | Optional | First two H2 headings; adds topic depth to the embedding |
| Inlinks | Optional | Internal link count; underlinked pages get a small ranking boost |

**Exporting from Screaming Frog:**
Run a standard crawl → Internal tab → Export. The default export includes URL, Title, Meta Description, and Inlinks. H2s are available under Content → Export.

**Exporting from Google Search Console:**
Search results → Pages → Export. This gives you URLs and click data. Pair with a Screaming Frog or Ahrefs export for titles and meta descriptions.

**Exporting from Ahrefs:**
Site Audit → Pages → Export. Includes URL, Title, Meta Description, and internal link counts.

### 3. Import your pages CSV

Click the extension icon → drag and drop your CSV into the **Import pages CSV** drop zone → click **Save & Import**.

The extension calls OpenAI to generate embeddings for each page. This runs in the background — you can close the popup and reopen it at any point to check progress. A **Cancel** button is available if you need to stop mid-import.

For a site with ~5,000 pages, embedding takes roughly 1–2 minutes and costs around $0.01–0.02 with `text-embedding-3-small`. Only include indexable, live pages that you want to drive internal links to.

Once complete, the popup shows how many pages were indexed, the embedding model, and the import date.

---

## Optional: Traffic and conversion data

To show **High traffic**, **Conversion driver**, and **Top performer** labels on suggestion cards — and apply a small ranking boost to those pages — import a separate traffic CSV.

**Export from GA4:**
Reports → Engagement → Pages and screens → add Conversions as a secondary metric → Export to CSV.

The CSV needs URL, Sessions, and Conversions columns. Labels are assigned using a volume-based threshold: pages that collectively account for the top share of total traffic are flagged as high traffic, and similarly for conversions.

**Threshold sensitivity** — after importing, a dropdown lets you adjust how broadly labels are applied:

| Setting | What it means |
|---|---|
| Strict (top 25%) | Only the highest-impact pages are labeled — fewer labels, higher bar |
| Balanced (top 50%) | Recommended default — covers pages with meaningfully outsized traffic |
| Broad (top 75%) | Labels more pages; useful for smaller sites with flatter traffic distributions |

You can switch between levels at any time without re-importing.

**Ranking boost values** (applied on top of semantic score):

| Label | Boost |
|---|---|
| 🏆 Top performer (high traffic + high conversions) | +15% |
| 💰 Conversion driver | +10% |
| 📈 High traffic | +8% |

Semantic relevance is always the primary signal. These boosts are intentionally small — they help surface pages that are both topically relevant and strategically valuable, but won't override a clearly better semantic match.

---

## Using the sidebar

### WordPress
Right-click highlighted text → **Find link opportunities for "…"**

The context menu captures your selection before the click clears it, which is the most reliable trigger in WordPress.

### Contentful
Either **highlight text and click the 🔗 button**, or **right-click highlighted text** → Find link opportunities.

To insert a link after copying a URL: highlight your anchor text in Contentful → press **⌘K** → paste the URL → confirm.

### Google Docs
Google Docs overrides the browser's native context menu and doesn't expose text selections to extensions. Click the 🔗 button → type your anchor text in the sidebar → get suggestions → copy the URL → highlight text in Docs → press **⌘K** → paste → Apply.

### Any other page or CMS
Highlight anchor text → click the 🔗 button, or press **⌘⇧L**.

---

## Sidebar controls

| Control | Action |
|---|---|
| `−` | Minimize sidebar |
| `×` | Close sidebar |
| `↻` | Re-run for current selection |
| `🗺` | Open embedding map in new tab |
| `Tips` | Toggle platform-specific how-to guide |

---

## Searching the index

The sidebar has a search bar to look up pages by URL path or title — useful for confirming specific directories are in your index before relying on them for suggestions. Search is independent of semantic matching and returns results instantly.

---

## Starting a new search

When results are showing, click **× New search** (next to the anchor text preview) to clear the current query and enter new anchor text.

---

## Embedding map

Click 🗺 in the sidebar header to open the embedding map in a new tab. It shows all indexed pages as a 2D projection of their OpenAI embedding vectors — pages that cluster together share semantic topic space.

- **Hover** a dot to see the page title, URL, and path
- **Click** a dot to open that page in a new tab
- **Scroll** to zoom, **drag** to pan
- **Filter** by section using the section buttons, or search by keyword
- **◎ Show outliers** highlights pages that sit far from the centroid of your index — these are topically unusual pages that may be over-specialized or uncategorized

---

## Ranking

Suggestions are ranked by a combined score:

1. **Centered cosine similarity** — the primary signal. The site-wide embedding centroid is subtracted from all vectors before scoring, so niche topic clusters don't produce artificially inflated scores.
2. **Inlink boost** — pages with fewer inbound internal links receive a small boost (up to +15% at 0 inlinks, tapering to 0 at 50+ inlinks) to surface underlinked content that deserves more equity.
3. **Traffic/conversion boost** — only applied when traffic data has been imported. High-traffic and conversion-driving pages receive small additive boosts to surface strategically valuable pages when they're also semantically relevant.

---

## Updating your index

Re-import your pages CSV whenever you've published significant new content or updated titles and meta descriptions. The import overwrites the previous index entirely.

Traffic data can be re-imported at any time without clearing your page index — useful for refreshing after a GA4 export covers a new date range.

---

## Troubleshooting

**"No API key set"** — Click the extension icon and add your OpenAI API key.

**"No pages indexed"** — Click the extension icon and import your pages CSV.

**"Invalid API key"** — Double-check your key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

**"OpenAI rate limit"** — The import pauses and retries automatically with exponential backoff. If it keeps failing, wait a minute and try again.

**Import appears stuck** — The import runs in a background service worker. Click off and back on the popup to check current progress. If it completed while the popup was closed, the status will update when you reopen it.

**The 🔗 button doesn't appear after import** — The extension injects automatically after a successful import. If it still doesn't appear after a few seconds, refresh the page.

**"Extension was reloaded — refresh this page"** — This appears when you install a new version of the extension while a tab was already open. Chrome keeps the old script running but cuts its background connection. Refresh the tab and the error will not recur. This is a one-time step any time you update the extension.

**A page I expect isn't showing up** — Use the URL search bar in the sidebar and search for part of the path (e.g. `/blog/slug`). If it returns no results, the page wasn't in your CSV — re-export and re-import.

**Traffic labels aren't showing on many pages** — Try switching the threshold sensitivity to Broad (top 75% of volume) in the popup. This is most common on smaller sites with a flatter traffic distribution.

**Suggestions seem off** — Match quality depends on your titles and meta descriptions. Pages with thin or missing meta descriptions will produce less precise matches. Adding H2 columns from a Screaming Frog export improves semantic depth significantly.

**Made code changes but nothing changed** — Go to `chrome://extensions` → click the reload ↻ icon on the extension, then refresh the page you're editing.

---

## Notes on cost

Embeddings are generated once at import time and stored locally in your browser — there is no ongoing API cost for browsing or getting suggestions. The only cost is re-importing after site updates.

With `text-embedding-3-small`:
- ~$0.02 per million tokens
- Indexing 10,000 pages costs under $0.05
- Each anchor text query at search time costs ~$0.00001

---

## File structure

```
extension/
├── manifest.json       ← Chrome MV3 config (v4.6)
├── content.js          ← Sidebar UI, platform detection, suggestion rendering
├── background.js       ← Service worker: embedding API, IndexedDB scoring, import pipeline
├── popup.html/js       ← Extension popup: CSV import, settings, traffic data
├── styles.css          ← Sidebar and card styles
├── visualize.html/js   ← Embedding map: 2D random projection scatter plot
└── icon*.png           ← Extension icons
```
