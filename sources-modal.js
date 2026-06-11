// sources-modal.js — modal in-app pour afficher un chunk RAG
// Logique de highlight portée de DPO-Agent (CitationBubble.svelte) en JS pur.
// Expose window.SnAiSourcesModal = { open(source) }

(function () {
  "use strict";

  var Z_INDEX = 2147483000;
  var BACKDROP_ID = "sn-ai-modal-backdrop";

  // --- Quote highlighter (porté de DPO-Agent CitationBubble.svelte:13-240) ---

  function splitOnEllipsis(quote) {
    return quote.split(/\s*(?:\.{3,}|…)\s*/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 3; });
  }

  function normalize(s) {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function mapNormalizedIndex(original, normalizedIdx) {
    var origIdx = 0;
    var normIdx = 0;
    var prevWhitespace = true;
    while (origIdx < original.length && normIdx < normalizedIdx) {
      var c = original[origIdx];
      if (/\s/.test(c)) {
        if (!prevWhitespace) normIdx++;
        prevWhitespace = true;
      } else {
        normIdx++;
        prevWhitespace = false;
      }
      origIdx++;
    }
    while (origIdx < original.length && /\s/.test(original[origIdx])) origIdx++;
    return origIdx;
  }

  function extendToOriginal(original, startIdx, normalizedTarget) {
    var end = startIdx;
    var targetIdx = 0;
    while (end < original.length && targetIdx < normalizedTarget.length) {
      var origChar = original[end];
      var targetChar = normalizedTarget[targetIdx];
      if (/\s/.test(origChar)) {
        end++;
        while (end < original.length && /\s/.test(original[end])) end++;
        if (targetChar === " ") targetIdx++;
      } else {
        if (origChar.toLowerCase() !== targetChar) return null;
        end++;
        targetIdx++;
      }
    }
    return targetIdx === normalizedTarget.length ? original.slice(startIdx, end) : null;
  }

  function findAnchored(concat, segment) {
    var words = segment.trim().split(/\s+/);
    if (words.length < 6) return null;

    var nAnchor = Math.min(5, Math.max(3, Math.floor(words.length / 3)));
    var startAnchor = words.slice(0, nAnchor).join(" ");
    var endAnchor = words.slice(-nAnchor).join(" ");

    var startPattern = escapeRegex(startAnchor).replace(/\s+/g, "\\s*");
    var endPattern = escapeRegex(endAnchor).replace(/\s+/g, "\\s*");

    var lower = concat.toLowerCase();
    var startMatch = new RegExp(startPattern, "i").exec(lower);
    if (!startMatch || startMatch.index === undefined) return null;

    var startBegin = startMatch.index;
    var endRe = new RegExp(endPattern, "ig");
    endRe.lastIndex = startBegin + startMatch[0].length;
    var endMatch = endRe.exec(lower);
    if (!endMatch) return null;

    var endEnd = endMatch.index + endMatch[0].length;
    if (endEnd - startBegin > segment.length * 2.2) return null;

    return { start: startBegin, end: endEnd, quality: "fuzzy" };
  }

  function findEndpoints(concat, segment) {
    var words = segment.trim().split(/\s+/);
    if (words.length < 4) return [];

    var n = Math.min(6, Math.max(3, Math.floor(words.length / 2)));
    var first = words.slice(0, n).join(" ");
    var last = words.slice(-n).join(" ");

    var firstPattern = escapeRegex(first).replace(/\s+/g, "\\s*");
    var lastPattern = escapeRegex(last).replace(/\s+/g, "\\s*");

    var lower = concat.toLowerCase();
    var ranges = [];

    var firstMatch = new RegExp(firstPattern, "i").exec(lower);
    if (firstMatch) {
      ranges.push({
        start: firstMatch.index,
        end: firstMatch.index + firstMatch[0].length,
        quality: "fuzzy",
      });
    }

    var lastRe = new RegExp(lastPattern, "ig");
    lastRe.lastIndex = firstMatch ? firstMatch.index + firstMatch[0].length : 0;
    var lastMatch = lastRe.exec(lower);
    if (lastMatch) {
      ranges.push({
        start: lastMatch.index,
        end: lastMatch.index + lastMatch[0].length,
        quality: "fuzzy",
      });
    }
    return ranges;
  }

  function findSegment(concat, segment) {
    var exact = concat.indexOf(segment);
    if (exact >= 0) return [{ start: exact, end: exact + segment.length, quality: "exact" }];

    var ci = concat.toLowerCase().indexOf(segment.toLowerCase());
    if (ci >= 0) return [{ start: ci, end: ci + segment.length, quality: "exact" }];

    var nConcat = normalize(concat);
    var nSeg = normalize(segment);
    var nIdx = nConcat.indexOf(nSeg);
    if (nIdx >= 0) {
      var origStart = mapNormalizedIndex(concat.toLowerCase(), nIdx);
      var matched = extendToOriginal(concat.toLowerCase(), origStart, nSeg);
      if (matched) {
        return [{ start: origStart, end: origStart + matched.length, quality: "exact" }];
      }
    }

    var anchored = findAnchored(concat, segment);
    if (anchored) return [anchored];

    return findEndpoints(concat, segment);
  }

  // Combien de segments de `quote` sont retrouvés dans `text` (exact-first).
  function segmentsMatched(quote, text) {
    var segs = splitOnEllipsis(quote);
    var out = { matched: 0, total: segs.length, exact: 0 };
    if (!segs.length || !text) return out;
    for (var i = 0; i < segs.length; i++) {
      var ranges = findSegment(text, segs[i]);
      if (ranges.length === 0) continue;
      out.matched++;
      var allExact = true;
      for (var j = 0; j < ranges.length; j++) {
        if (ranges[j].quality !== "exact") allExact = false;
      }
      if (allExact) out.exact++;
    }
    return out;
  }

  // L'extrait est-il présent (au moins en majorité) dans le texte ?
  function quoteIsIn(quote, text) {
    var r = segmentsMatched(quote, text);
    return r.total > 0 && (r.exact >= 1 || r.matched >= Math.ceil(r.total / 2));
  }

  // Cherche, parmi les autres sources, celle qui contient le mieux l'extrait.
  // Utilisé quand la source citée par le LLM ne contient pas la phrase (le LLM
  // se trompe parfois de numéro de source). Retourne la meilleure source ou null.
  function findBestSource(quote, corpus, excludeNumber) {
    var best = null, bE = -1, bM = -1, bS = -1;
    for (var i = 0; i < corpus.length; i++) {
      var s = corpus[i];
      if (s.number === excludeNumber) continue;
      var text = s.context_content || s.precise_content || s.snippet || "";
      var r = segmentsMatched(quote, text);
      if (r.matched === 0) continue;
      var sc = typeof s.score === "number" ? s.score : 0;
      if (r.exact > bE ||
          (r.exact === bE && r.matched > bM) ||
          (r.exact === bE && r.matched === bM && sc > bS)) {
        best = s; bE = r.exact; bM = r.matched; bS = sc;
      }
    }
    return best;
  }

  function highlightQuote(container, quote) {
    if (!quote) return;
    var segments = splitOnEllipsis(quote);
    if (segments.length === 0) return;

    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var parts = [];
    var concat = "";
    var current;
    while ((current = walker.nextNode())) {
      var text = current.textContent || "";
      parts.push({ node: current, start: concat.length, length: text.length });
      concat += text;
    }

    var matches = [];
    for (var i = 0; i < segments.length; i++) {
      var ranges = findSegment(concat, segments[i]);
      for (var j = 0; j < ranges.length; j++) matches.push(ranges[j]);
    }
    if (matches.length === 0) return;

    matches.sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    for (var k = 0; k < matches.length; k++) {
      var m = matches[k];
      var last = merged[merged.length - 1];
      if (last && m.start <= last.end) {
        last.end = Math.max(last.end, m.end);
        if (m.quality === "fuzzy") last.quality = "fuzzy";
      } else {
        merged.push({ start: m.start, end: m.end, quality: m.quality });
      }
    }

    var firstMark = null;
    for (var n = merged.length - 1; n >= 0; n--) {
      var s = merged[n].start, e = merged[n].end, q = merged[n].quality;
      var startPart = null, endPart = null;
      for (var p = 0; p < parts.length; p++) {
        if (s >= parts[p].start && s < parts[p].start + parts[p].length) startPart = parts[p];
        if (e > parts[p].start && e <= parts[p].start + parts[p].length) endPart = parts[p];
      }
      if (!startPart || !endPart) continue;
      try {
        var range = document.createRange();
        range.setStart(startPart.node, s - startPart.start);
        range.setEnd(endPart.node, e - endPart.start);
        var mark = document.createElement("mark");
        mark.className = q === "fuzzy" ? "highlight fuzzy" : "highlight";
        range.surroundContents(mark);
        firstMark = mark;
      } catch (err) {
        // range crossed an element boundary; skip this segment
      }
    }

    if (firstMark) {
      firstMark.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // --- Modal rendering ---

  function renderMarkdown(md) {
    if (typeof window.marked === "undefined" || typeof window.DOMPurify === "undefined") {
      var pre = document.createElement("pre");
      pre.textContent = md || "";
      pre.style.whiteSpace = "pre-wrap";
      return pre.outerHTML;
    }
    var html = window.marked.parse(md || "", { async: false, gfm: true, breaks: true });
    return window.DOMPurify.sanitize(html);
  }

  function buildSourceUrl(source) {
    if (!source.source_url) return "";
    var url = source.source_url;
    // The backend (build_document_url) already appends "#page=N" to source_url
    // for PDFs, so we must NOT add a second one (which produced a malformed
    // "...pdf#page=5&page=5" that strict PDF viewers ignore, opening at page 1).
    // We only build the anchor here when it's missing, keeping this idempotent.
    var hasFragment = url.indexOf("#") !== -1;
    if (
      source.file_type === "html" &&
      source.search_text_start &&
      source.search_text_end
    ) {
      if (url.indexOf(":~:text=") === -1) {
        var start = encodeURIComponent(source.search_text_start);
        var end = encodeURIComponent(source.search_text_end);
        url += (hasFragment ? "&" : "#") + ":~:text=" + start + "," + end;
      }
    } else if (source.file_type === "pdf" && typeof source.page_number === "number") {
      if (!/[#&]page=/.test(url)) {
        url += (hasFragment ? "&" : "#") + "page=" + source.page_number;
      }
    }
    return url;
  }

  function close() {
    var existing = document.getElementById(BACKDROP_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  function open(source, options) {
    if (!source) return;
    close(); // close any existing modal first
    options = options || {};

    // Fallback "mauvaise source" : si la citation pointe une source qui ne
    // contient pas l'extrait (le LLM se trompe parfois de numéro), on bascule
    // sur la source qui le contient réellement.
    var _quote = options.quote || source.quote || "";
    var _corpus = Array.isArray(options.corpus) ? options.corpus : [];
    var correctedFrom = null;
    if (_quote && _corpus.length > 1) {
      var citedText = source.context_content || source.precise_content || source.snippet || "";
      if (!quoteIsIn(_quote, citedText)) {
        var alt = findBestSource(_quote, _corpus, source.number);
        if (alt) { correctedFrom = source.number; source = alt; }
      }
    }

    var backdrop = document.createElement("div");
    backdrop.id = BACKDROP_ID;
    backdrop.className = "sn-ai-modal-backdrop";
    backdrop.style.zIndex = String(Z_INDEX);
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close();
    });

    var modal = document.createElement("div");
    modal.className = "sn-ai-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    // Header
    var header = document.createElement("div");
    header.className = "sn-ai-modal-header";

    var titleEl = document.createElement("h3");
    titleEl.className = "sn-ai-modal-title";
    titleEl.textContent = "[" + source.number + "] " + (source.title || "Source");
    header.appendChild(titleEl);

    var closeBtn = document.createElement("button");
    closeBtn.className = "sn-ai-modal-close";
    closeBtn.setAttribute("aria-label", "Fermer");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);

    modal.appendChild(header);

    // Meta line: header_path · page · score
    var metaParts = [];
    if (source.header_path) metaParts.push(source.header_path);
    if (typeof source.page_number === "number") metaParts.push("p. " + source.page_number);
    if (typeof source.score === "number") metaParts.push(Math.round(source.score * 100) + "%");
    if (metaParts.length > 0) {
      var meta = document.createElement("div");
      meta.className = "sn-ai-modal-meta";
      meta.textContent = metaParts.join(" · ");
      modal.appendChild(meta);
    }

    // Note si on a corrigé la source (citation pointant la mauvaise source).
    if (correctedFrom !== null) {
      var note = document.createElement("div");
      note.className = "sn-ai-modal-note";
      note.style.cssText = "font-size:11px;color:#8a6d00;background:#fff8e1;" +
        "border:1px solid #ffe082;border-radius:4px;padding:6px 8px;margin-bottom:8px;";
      note.textContent = "La citation [" + correctedFrom + "] ne contenait pas l'extrait — " +
        "affichage de la source [" + source.number + "] qui le contient.";
      modal.appendChild(note);
    }

    // Body — markdown rendu. On affiche context_content (chunk parent large)
    // car c'est le texte que le LLM a vu et dans lequel la phrase verbatim
    // citée se trouve forcément. Fallback sur precise_content puis snippet.
    var body = document.createElement("div");
    body.className = "sn-ai-modal-body markdown";
    var contentToRender = source.context_content || source.precise_content || source.snippet || "";
    body.innerHTML = renderMarkdown(contentToRender);
    modal.appendChild(body);

    // Highlight the LLM-cited verbatim quote, if any. Per-citation override
    // (options.quote) takes precedence over a legacy quote attached to the
    // source object itself.
    var quoteToHighlight = options.quote || source.quote || "";
    if (quoteToHighlight) {
      // Defer to next frame so layout is computed before scrollIntoView
      requestAnimationFrame(function () { highlightQuote(body, quoteToHighlight); });
    }

    // Footer — lien externe vers la source
    var url = buildSourceUrl(source);
    if (url) {
      var footer = document.createElement("div");
      footer.className = "sn-ai-modal-footer";
      var link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "sn-ai-modal-link";
      var label = "Ouvrir la source";
      if (source.file_type === "html" && source.search_text_start) label += " (extrait surligné)";
      else if (source.file_type === "pdf" && typeof source.page_number === "number") label += " (page " + source.page_number + ")";
      link.textContent = label;
      footer.appendChild(link);
      modal.appendChild(footer);
    }

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    document.addEventListener("keydown", onKeydown);

    // Focus the close button for keyboard users
    closeBtn.focus();
  }

  window.SnAiSourcesModal = { open: open, close: close };
})();
