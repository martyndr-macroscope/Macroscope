/* global pdfjsLib */  // provided by index.html

/* global pdfjsLib */  // provided by index.html

(function (global) {
  // ────────────────────────────────────────────────────────────────────────────
  // Basics
  // ────────────────────────────────────────────────────────────────────────────
  const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>]+/i;

  async function pdfToText(arrayBuffer, onProgress) {
    if (!global.pdfjsLib?.getDocument) throw new Error('PDF.js not available');
    const task = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf  = await task.promise;
    let out = '';
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      out += content.items.map(it => it.str).join(' ') + '\n';
      onProgress?.(p, pdf.numPages);
      await new Promise(r => setTimeout(r, 0));
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function guessTitleFromPdfText(txt) {
    const stopIdx = txt.toLowerCase().indexOf(' abstract');
    const head = txt.slice(0, stopIdx > 0 ? stopIdx : Math.min(1200, txt.length));
    const cands = head.split(/[\n\.]/).map(s => s.trim()).filter(s => s.length >= 8);
    const score = s =>
      (/[A-Z][a-z]/.test(s) ? 1 : 0) +
      (s.length <= 180 ? 1 : 0) +
      (/\w{4,}/.test(s) ? 1 : 0);
    cands.sort((a,b) => score(b) - score(a));
    return cands[0] || '';
  }

// Drop-in replacement
async function fetchJson(url, viaProxy) {
  // Always include contact info for OpenAlex
  const mail = (global.OPENALEX_MAILTO || global.UNPAYWALL_EMAIL || '').trim();
  const addMailto = (u) => {
    if (!mail) return u;
    if (u.includes('mailto=')) return u;
    return u + (u.includes('?') ? '&' : '?') + 'mailto=' + encodeURIComponent(mail);
  };

  const u = addMailto(url);
  const first = viaProxy ? viaProxy(u) : u;

  // ---- global throttle (simple token bucket) ----
  const NOW = Date.now();
  const GAP = (global.__OA_MIN_INTERVAL_MS__ ??= 350); // ~3 req/sec max
  const nextOk = (global.__OA_NEXT_OK_TS__ ??= 0);
  const wait = Math.max(0, nextOk - NOW);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  // ---- retry with exponential backoff & Retry-After ----
  const MAX_TRIES = 6;
  let attempt = 0;
  let lastErr;

  while (attempt < MAX_TRIES) {
    attempt++;
    let resp, triedDirectFallback = false;

    try {
      resp = await fetch(first, { redirect: 'follow' });

      // Proxy might block some patterns → single direct retry on 403
      if (resp.status === 403) {
        triedDirectFallback = true;
        const direct = await fetch(u, { redirect: 'follow' });
        if (!direct.ok) throw Object.assign(new Error(`HTTP ${direct.status}`), { status: direct.status, headers: direct.headers });
        // schedule next token time
        global.__OA_NEXT_OK_TS__ = Date.now() + GAP;
        return await direct.json();
      }

      if (resp.ok) {
        global.__OA_NEXT_OK_TS__ = Date.now() + GAP;
        return await resp.json();
      }

      // Handle rate limits / transient server errors
      const status = resp.status;
      const h = resp.headers;
      if (status === 429 || status === 502 || status === 503 || status === 504) {
        // Respect Retry-After if supplied
        const ra = Number(h.get('Retry-After')) || 0;
        const backoff = ra > 0 ? ra * 1000 : Math.min(12000, 400 * Math.pow(1.8, attempt - 1)) + Math.floor(Math.random()*300);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }

      // Other HTTP errors → don’t retry forever
      throw Object.assign(new Error(`HTTP ${status}`), { status, headers: h });

    } catch (e) {
      lastErr = e;

      // If proxy path failed before any response, try direct once
      if (!triedDirectFallback && !resp) {
        try {
          const direct = await fetch(u, { redirect: 'follow' });
          if (direct.ok) {
            global.__OA_NEXT_OK_TS__ = Date.now() + GAP;
            return await direct.json();
          }
          const status = direct.status;
          if (status === 429 || status === 502 || status === 503 || status === 504) {
            const ra = Number(direct.headers.get('Retry-After')) || 0;
            const backoff = ra > 0 ? ra * 1000 : Math.min(12000, 400 * Math.pow(1.8, attempt - 1)) + Math.floor(Math.random()*300);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          throw Object.assign(new Error(`HTTP ${status}`), { status, headers: direct.headers });
        } catch (e2) {
          lastErr = e2;
        }
      }

      // Backoff for network errors too, then retry
      const backoff = Math.min(12000, 400 * Math.pow(1.8, attempt - 1)) + Math.floor(Math.random()*300);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  throw lastErr || new Error('OpenAlex request failed');
}



  // ────────────────────────────────────────────────────────────────────────────
  // OpenAlex helpers
  // ────────────────────────────────────────────────────────────────────────────
  const OA_ID_RE = /(?:openalex\.org\/)?(W\d+)/i;
  const normId = id => {
    if (!id) return null;
    const s = String(id);
    const m = s.match(OA_ID_RE);
    return m ? `https://openalex.org/${m[1]}` : s;
  };

  function widOf(id) {
    const s = String(id || '');
    const m = s.match(/W\d+/i);
    return m ? m[0].toUpperCase() : null;
  }
  function urlOfWid(wid) {
    return wid ? `https://openalex.org/${wid}` : null;
  }

  async function searchOpenAlex({ doi, title }, viaProxy) {
    if (doi) {
      try {
        const u = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`;
        const w = await fetchJson(u, viaProxy);
        if (w?.id) return w;
      } catch {} // fall through to title search
    }
    if (title) {
      const u = `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=5`;
      const r = await fetchJson(u, viaProxy);
      const best = Array.isArray(r?.results) ? r.results[0] : null;
      if (best?.id) return best;
    }
    return null;
  }

function mapOpenAlexWorkToItem(work) {
  const title = work?.title || work?.display_name || '(untitled)';
  const authorships = Array.isArray(work?.authorships) ? work.authorships : [];
  const authors = authorships.map(a => a?.author?.display_name).filter(Boolean);

  // Venue (prefer host venue, fall back to primary location source)
  const venue =
    work?.host_venue?.display_name ||
    work?.primary_location?.source?.display_name ||
    null;

  // Institutions (unique by id, name as display)
  const insts = [];
  const instSeen = new Set();
  for (const a of authorships) {
    const arr = Array.isArray(a?.institutions) ? a.institutions : [];
    for (const inst of arr) {
      const id = inst?.id || inst?.ror || inst?.display_name;
      if (!id || instSeen.has(id)) continue;
      instSeen.add(id);
      insts.push({
        id: inst?.id || null,
        ror: inst?.ror || null,
        display_name: inst?.display_name || null,
        country_code: inst?.country_code || null
      });
    }
  }

  const year = work?.publication_year || work?.from_publication_date?.slice(0,4) || null;
  const oa   = !!(work?.open_access?.is_oa);
  const cbc  = Number(work?.cited_by_count || 0);

  return {
    label: title,
    authors,                       // names (UI)
    year,
    oa,
    cbc,
    venue,                         // NEW: e.g., journal/conference
    institutions: insts,           // NEW: list with ids + names
    authorIds: authorships.map(a => a?.author?.id).filter(Boolean),  // helpful for linking
    hasAbs: !!(work?.abstract_inverted_index || work?.abstract),
    openalex: work,                // keep raw for anything else
    hasFullText: false
  };
}

  const toItem = mapOpenAlexWorkToItem;

  // ────────────────────────────────────────────────────────────────────────────
  // Import a local PDF → OpenAlex work
  // ────────────────────────────────────────────────────────────────────────────
  /**
   * hooks:
   *  - viaProxy(url) -> string           // optional
   *  - onStatus(msg, pct)                // optional
   *  - onWork(item, workRaw)             // optional: host adds the node
   */
  async function importPdfFile(file, hooks = {}) {
    const { viaProxy, onStatus, onWork } = hooks;
    if (!(file instanceof Blob)) throw new Error('file must be a Blob/File');

    onStatus?.('Reading PDF…', 0.02);
    const buf = await file.arrayBuffer();

    onStatus?.('Extracting text…', 0.08);
    const txt = await pdfToText(buf, (p, N) =>
      onStatus?.(`Extracting text… page ${p}/${N}`, 0.08 + 0.6 * (p / N))
    );

    const doiMatch = txt.match(DOI_RE);
    const doi   = doiMatch ? doiMatch[0].replace(/[)\].,;]$/, '') : null;
    const title = doi ? '' : guessTitleFromPdfText(txt);

    onStatus?.(doi ? 'Found DOI – querying OpenAlex…' : 'No DOI found – searching by title…', 0.72);
    const work = await searchOpenAlex({ doi, title }, viaProxy);
    if (!work) throw new Error('No matching record found on OpenAlex');

    const item = mapOpenAlexWorkToItem(work);
    onWork?.(item, work);

    onStatus?.('Done', 1.0);
    return { item, work };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Batch helpers for expansions
  // ────────────────────────────────────────────────────────────────────────────
  async function fetchWorksByIds(openalexIds, viaProxy, onBatch) {
  // Normalise to WIDs (W123456…) and de-dupe
  const wids = Array.from(
    new Set(
      (openalexIds || [])
        .map(id => {
          const m = String(id || '').match(/W\d+/i);
          return m ? m[0].toUpperCase() : null;
        })
        .filter(Boolean)
    )
  );

  const out = [];
  const CHUNK = 40; // ~safe length; 40* (WID+pipe) keeps URL well under common limits
  for (let i = 0; i < wids.length; i += CHUNK) {
    const slice = wids.slice(i, i + CHUNK);
    const filter = `ids.openalex:${slice.join('|')}`;
    const u = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=${Math.min(200, slice.length)}`;

    const r = await fetchJson(u, viaProxy);  // fetchJson already injects mailto + proxy→direct fallback
    const works = Array.isArray(r?.results) ? r.results : [];
    out.push(...works);

    onBatch?.(works, { offset: i, total: wids.length });
    // Be polite & give the UI a breath
    await new Promise(res => setTimeout(res, 25));
  }
  return out;
}

  // ────────────────────────────────────────────────────────────────────────────
  // Expand: Cited (left side L1/L2)
  // ────────────────────────────────────────────────────────────────────────────
  /**
   * @returns {Promise<{ level1: any[], level2: any[], edgesOA: Array<[string,string]> }>}
   * edgesOA are [fromOAUrl, toOAUrl] for building links.
   */
async function fetchWork(openalexId, viaProxy) {
  // Accept WID (“W123…”) or full URL
  const s = String(openalexId || '');
  const m = s.match(/W\d+/i);
  const wid = m ? m[0].toUpperCase() : null;
  if (!wid) throw new Error('fetchWork: invalid OpenAlex id');
  const url = `https://api.openalex.org/works/${wid}`;
  return fetchJson(url, viaProxy);
}

  async function expandCited({ openalexId, depth = 1, viaProxy, onProgress, onBatch } = {}) {
    const seedUrl = normId(openalexId);
    const seedWid = widOf(seedUrl);
    if (!seedWid) throw new Error('expandCited: invalid openalexId');

    onProgress?.('Loading seed work…', 0.02);
    const seed = await fetchJson(`https://api.openalex.org/works/${seedWid}`, viaProxy);

    const L1ids = Array.isArray(seed?.referenced_works) ? seed.referenced_works.map(normId) : [];
    const uniqL1 = Array.from(new Set(L1ids)).filter(Boolean);

    onProgress?.(`Fetching ${uniqL1.length} cited works…`, 0.12);
    const level1 = await fetchWorksByIds(uniqL1, viaProxy, (works, meta) => {
      onBatch?.(works, { level: 1, fromId: seedUrl, meta });
      const frac = meta.total ? (meta.offset + works.length) / meta.total : 1;
      onProgress?.('Adding cited works…', 0.12 + 0.4 * frac);
    });

    const edgesOA = uniqL1.map(id => [seedUrl, id]);

    let level2 = [];
    if (depth === 2 && level1.length) {
      onProgress?.('Collecting second-level references…', 0.58);
      const L2set = new Set();
      for (const w of level1) {
        const refs = Array.isArray(w?.referenced_works) ? w.referenced_works : [];
        for (const r of refs) {
          const nid = normId(r);
          if (nid && nid !== seedUrl) L2set.add(nid);
          if (nid) edgesOA.push([normId(w.id), nid]);  // L1 → L2 edges
        }
      }
      // Avoid duplicating L1:
      for (const id of uniqL1) L2set.delete(id);

      const uniqL2 = Array.from(L2set);
      onProgress?.(`Fetching ${uniqL2.length} second-level cited works…`, 0.62);
      level2 = await fetchWorksByIds(uniqL2, viaProxy, (works, meta) => {
        onBatch?.(works, { level: 2, meta });
        const frac = meta.total ? (meta.offset + works.length) / meta.total : 1;
        onProgress?.('Adding second-level…', 0.62 + 0.36 * frac);
      });
    }

    onProgress?.('Done', 1.0);
    return { level1, level2, edgesOA };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Expand: Cited-By (right side L1)
  // ────────────────────────────────────────────────────────────────────────────
  /**
   * Paged fetch of papers that cite the seed.
   * @param {object} opts
   *   - openalexId: string (W… or full URL)
   *   - limit: max number of citing works to pull (default 1000)
   *   - viaProxy/onProgress/onBatch same shape as expandCited
   */
  async function expandCitedBy({
  openalexId,
  limit = 1000,
  depth = 1,
  l2PerParent = 120,
  l2GlobalCap = 4000,
  viaProxy,
  onProgress,
  onBatch
} = {}) {
  const seedUrl = normId(openalexId);
  const seedWid = widOf(seedUrl);
  if (!seedWid) throw new Error('expandCitedBy: invalid openalexId');

  // Helper to page a “who cites W…” query
 // Cursor-based pager (OpenAlex-recommended)
async function pageCitingWorksForWid(wid, maxTake, progressLabel, progressStart, progressSpan) {
  const PER = 200;                          // OpenAlex max
  let got = 0;
  let cursor = '*';
  const out = [];

  while (cursor && got < maxTake) {
    const room = Math.max(0, maxTake - got);
    const take = Math.min(PER, room);
    const u = `https://api.openalex.org/works?filter=${encodeURIComponent(`cites:${wid}`)}&per-page=${take}&cursor=${encodeURIComponent(cursor)}`;
    const r = await fetchJson(u, viaProxy);

    const batch = Array.isArray(r?.results) ? r.results : [];
    if (!batch.length) break;

    out.push(...batch);
    got += batch.length;

    const p = progressStart + progressSpan * Math.min(1, got / Math.max(1, maxTake));
    onProgress?.(progressLabel, p);

    cursor = r?.meta?.next_cursor || null;
    await new Promise(res => setTimeout(res, 180));
  }
  return out;
}


  const edgesOA = [];

  // L1: works that cite the seed
  onProgress?.('Fetching “cited by” (L1)…', 0.08);
  const citedByL1 = await pageCitingWorksForWid(seedWid, limit, 'Adding “cited by”…', 0.12, 0.48);
  // Emit in manageable chunks to the UI
  if (citedByL1.length) {
    const chunk = 200;
    for (let i = 0; i < citedByL1.length; i += chunk) {
      const part = citedByL1.slice(i, i + chunk);
      onBatch?.(part, { level: 1 });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  for (const w of citedByL1) {
    const from = normId(w.id);
    if (from && seedUrl) edgesOA.push([from, seedUrl]); // L1 citing → seed
  }

  if (depth !== 2 || !citedByL1.length) {
    onProgress?.('Done', 1.0);
    return { citedBy: citedByL1, edgesOA };
  }

  // L2: works that cite each L1 paper
  onProgress?.('Collecting L2 “cited by”…', 0.62);
  const seenL2 = new Set(); // de-dupe across all parents
  let totalL2 = 0;

  for (let idx = 0; idx < citedByL1.length; idx++) {
    const parent = citedByL1[idx];
    const parentId = normId(parent?.id);
    const parentWid = widOf(parentId);
    if (!parentWid) continue;

    // Fetch citers of this parent
    const label = `L2 for ${idx + 1}/${citedByL1.length}…`;
    const batch = await pageCitingWorksForWid(parentWid, l2PerParent, label, 0.64, 0.30);

    // Filter & de-dupe
    const fresh = [];
    for (const w of batch) {
      const wid = normId(w?.id);
      if (!wid || wid === seedUrl || wid === parentId) continue;
      if (seenL2.has(wid)) continue;
      seenL2.add(wid);
      fresh.push(w);
      edgesOA.push([wid, parentId]); // L2 citing → L1 parent
    }

    if (fresh.length) {
      onBatch?.(fresh, { level: 2, parent: parentId });
      totalL2 += fresh.length;
      await new Promise(r => setTimeout(r, 0));
    }
await new Promise(r => setTimeout(r, 120));
    if (totalL2 >= l2GlobalCap) break; // safety valve
  }

  onProgress?.('Done', 1.0);
  return { citedBy: citedByL1, edgesOA };
}

// Resolve a single work by DOI (returns { work, item })
  // ... keep expandCited, expandCitedBy, fetchWork, etc. here

  // ADD (inside the IIFE, just before the closing line)
  async function resolveByDOI(doi, { viaProxy } = {}) {
    const work = await searchOpenAlex({ doi, title: '' }, viaProxy);
    if (!work?.id) throw new Error('No OpenAlex record found for that DOI');
    return { work, item: mapOpenAlexWorkToItem(work) };
  }

  async function resolveByWID(wid, { viaProxy } = {}) {
    const work = await fetchWork(wid, viaProxy);
    if (!work?.id) throw new Error('No OpenAlex record found for that id');
    return { work, item: mapOpenAlexWorkToItem(work) };
  }

  // Export a single clean API (still inside the IIFE)
  global.DataRetrieval = {
    importPdfFile,
    expandCited,
    expandCitedBy,
    fetchWork,
    toItem,
    resolveByDOI,
    resolveByWID
  };

})



(window);  // <-- this line stays last


