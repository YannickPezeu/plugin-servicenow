// proposition-box.js — Box "Proposition IA" affichée sous la textarea SN.
// Rendue en markdown avec citations [N] cliquables qui ouvrent la modal source.
// Expose window.SnAiPropositionBox = { render(host, data), setLoading(host), setEmpty(host), setError(host, msg) }

(function () {
  "use strict";

  var ROBOT_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="22" height="22">' +
    '<rect x="5" y="9" width="14" height="10" rx="2" ry="2"/>' +
    '<circle cx="9" cy="14" r="1.5" fill="#fff"/>' +
    '<circle cx="15" cy="14" r="1.5" fill="#fff"/>' +
    '<rect x="10" y="17" width="4" height="1.5" rx="0.75" fill="#fff"/>' +
    '<rect x="11" y="4" width="2" height="4" rx="1"/>' +
    '<circle cx="12" cy="3" r="1.5"/>' +
    '<rect x="2" y="12" width="2" height="4" rx="1"/>' +
    '<rect x="20" y="12" width="2" height="4" rx="1"/>' +
    "</svg>";

  var SPINNER_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="22" height="22" class="sn-ai-spinner-svg">' +
    '<circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.3)" stroke-width="3"/>' +
    '<path d="M12 3a9 9 0 0 1 9 9" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' +
    "</svg>";

  var COPY_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">' +
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
    "</svg>";

  function renderMarkdown(md) {
    if (typeof window.marked === "undefined" || typeof window.DOMPurify === "undefined") {
      var pre = document.createElement("pre");
      pre.textContent = md || "";
      pre.style.whiteSpace = "pre-wrap";
      return pre.outerHTML;
    }
    var html = window.marked.parse(md || "", { async: false, gfm: true, breaks: true });
    // Allow our citation buttons (and their data-* attrs) through DOMPurify
    return window.DOMPurify.sanitize(html, {
      ADD_TAGS: ["button"],
      ADD_ATTR: ["data-source-num", "data-quote-id", "data-quote", "type"],
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Replace citations in the markdown text with HTML button placeholders.
   * Supports two formats:
   *   - `[N]`            (legacy, no quote)
   *   - `[N: "verbatim"]`  (DPO-style: highlights the verbatim phrase in the modal)
   *
   * Quotes are stored in a side map (keyed by an auto-incremented quote id) so
   * we don't risk re-encoding issues through marked + DOMPurify. The button
   * carries `data-source-num` and optional `data-quote-id`.
   *
   * Returns: { text, quotes }  where quotes is an array indexed by quote id.
   */
  // Remplace [N] / [N: "verbatim"] par des boutons cliquables. Le quote est
  // embarqué directement dans data-quote (URL-encodé) pour qu'un handler délégué
  // puisse le résoudre même après qu'un re-render de streaming ait détaché le
  // bouton. Retourne le texte (string) prêt pour le markdown.
  function injectCitationPlaceholders(text, sources) {
    var bySource = {};
    sources.forEach(function (s) { bySource[s.number] = s; });
    var regex = /\[(\d+)(?::\s*"([^"]+)")?\]/g;
    return String(text).replace(regex, function (match, numStr, quote) {
      var num = parseInt(numStr, 10);
      if (!bySource[num]) return match; // citation inconnue, on laisse tel quel
      var attrs = 'class="sn-ai-citation" data-source-num="' + num + '"';
      if (quote) attrs += ' data-quote="' + encodeURIComponent(quote) + '"';
      return '<button type="button" ' + attrs + '>[' + num + ']</button>';
    });
  }

  // Handler de citation DÉLÉGUÉ, installé une fois par body. Utilise mousedown
  // (pas click) pour se déclencher AVANT qu'un re-render de streaming ne détache
  // le bouton, et résout la source depuis body._snSources (qui survit au
  // re-render). C'est ce qui rend les sources cliquables dès leur apparition.
  function installCitationDelegation(body) {
    function press(e) {
      if (e.type === "mousedown" && e.button !== 0) return;
      var btn = e.target && e.target.closest ? e.target.closest(".sn-ai-citation") : null;
      if (!btn) return;
      e.preventDefault();
      var sources = body._snSources || [];
      var num = parseInt(btn.getAttribute("data-source-num"), 10);
      var src = null;
      for (var i = 0; i < sources.length; i++) {
        if (sources[i].number === num) { src = sources[i]; break; }
      }
      if (!src) return;
      var raw = btn.getAttribute("data-quote");
      var quote = raw ? decodeURIComponent(raw) : "";
      if (window.SnAiSourcesModal && typeof window.SnAiSourcesModal.open === "function") {
        window.SnAiSourcesModal.open(src, { quote: quote });
      }
    }
    body.addEventListener("mousedown", press);
    body.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") press(e);
    });
  }

  function buildBoxSkeleton(host, options) {
    var box = document.createElement("div");
    box.className = "sn-ai-proposition-box";

    // Header
    var header = document.createElement("div");
    header.className = "sn-ai-proposition-header";

    var title = document.createElement("div");
    title.className = "sn-ai-proposition-title";
    title.textContent = "Proposition IA";
    header.appendChild(title);

    var actions = document.createElement("div");
    actions.className = "sn-ai-proposition-actions";

    var generateBtn = document.createElement("button");
    generateBtn.type = "button";
    generateBtn.className = "sn-ai-proposition-generate";
    generateBtn.title = "Générer une proposition de réponse";
    generateBtn.innerHTML = ROBOT_SVG + '<span class="sn-ai-btn-label">Générer</span>';
    if (options && typeof options.onGenerate === "function") {
      generateBtn.addEventListener("click", options.onGenerate);
    }
    actions.appendChild(generateBtn);

    var copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "sn-ai-proposition-copy";
    copyBtn.title = "Copier la proposition (texte brut)";
    copyBtn.innerHTML = COPY_SVG + '<span class="sn-ai-btn-label">Copier</span>';
    copyBtn.disabled = true; // enabled once content exists
    actions.appendChild(copyBtn);

    header.appendChild(actions);
    box.appendChild(header);

    // Body (state-dependent)
    var body = document.createElement("div");
    body.className = "sn-ai-proposition-body markdown";
    installCitationDelegation(body);
    box.appendChild(body);

    // Status footer (optional, for transient messages)
    var status = document.createElement("div");
    status.className = "sn-ai-proposition-status";
    box.appendChild(status);

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(box);

    return { box: box, generateBtn: generateBtn, copyBtn: copyBtn, body: body, status: status };
  }

  function getRefs(host) {
    var box = host.querySelector(".sn-ai-proposition-box");
    if (!box) return null;
    return {
      box: box,
      generateBtn: box.querySelector(".sn-ai-proposition-generate"),
      copyBtn: box.querySelector(".sn-ai-proposition-copy"),
      body: box.querySelector(".sn-ai-proposition-body"),
      status: box.querySelector(".sn-ai-proposition-status"),
    };
  }

  function ensureSkeleton(host, options) {
    var refs = getRefs(host);
    if (refs) return refs;
    return buildBoxSkeleton(host, options);
  }

  function setEmpty(host, options) {
    var refs = ensureSkeleton(host, options);
    refs.body.innerHTML = '<p class="sn-ai-proposition-placeholder">' +
      "Cliquez sur <strong>Générer</strong> pour proposer une réponse à partir des documents du référentiel." +
      "</p>";
    refs.status.textContent = "";
    refs.copyBtn.disabled = true;
    refs.generateBtn.disabled = false;
    refs.generateBtn.classList.remove("sn-ai-loading");
    refs.generateBtn.innerHTML = ROBOT_SVG + '<span class="sn-ai-btn-label">Générer</span>';
  }

  function setLoading(host, options) {
    var refs = ensureSkeleton(host, options);
    refs.generateBtn.disabled = true;
    refs.generateBtn.classList.add("sn-ai-loading");
    refs.generateBtn.innerHTML = SPINNER_SVG + '<span class="sn-ai-btn-label">Génération…</span>';
    refs.status.textContent = "Appel du modèle en cours…";
    refs.copyBtn.disabled = true;
  }

  function setError(host, message, options) {
    var refs = ensureSkeleton(host, options);
    refs.body.innerHTML = '<p class="sn-ai-proposition-error">' +
      "Erreur : " + (message || "Impossible de générer la proposition.") +
      "</p>";
    refs.status.textContent = "";
    refs.generateBtn.disabled = false;
    refs.generateBtn.classList.remove("sn-ai-loading");
    refs.generateBtn.innerHTML = ROBOT_SVG + '<span class="sn-ai-btn-label">Réessayer</span>';
    refs.copyBtn.disabled = true;
  }

  function render(host, data, options) {
    var refs = ensureSkeleton(host, options);
    var text = (data && data.text) || "";
    var sources = (data && Array.isArray(data.sources)) ? data.sources : [];

    if (!text.trim()) {
      setEmpty(host, options);
      return;
    }

    refs.body._snSources = sources;
    refs.body.innerHTML = renderMarkdown(injectCitationPlaceholders(text, sources));

    // Sources list at the bottom of the body for quick scan
    if (sources.length > 0) {
      var listWrap = document.createElement("div");
      listWrap.className = "sn-ai-proposition-sources";
      var listTitle = document.createElement("div");
      listTitle.className = "sn-ai-proposition-sources-title";
      listTitle.textContent = "Sources (" + sources.length + ")";
      listWrap.appendChild(listTitle);

      var list = document.createElement("div");
      list.className = "sn-ai-sources-list";
      sources.forEach(function (source) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "sn-ai-source-row";
        if (!source.cited) row.classList.add("sn-ai-source-uncited");

        var num = document.createElement("span");
        num.className = "sn-ai-source-num";
        num.textContent = "[" + source.number + "]";
        row.appendChild(num);

        var title = document.createElement("span");
        title.className = "sn-ai-source-title";
        title.textContent = source.title || "Source";
        row.appendChild(title);

        var metaParts = [];
        if (source.header_path) metaParts.push(source.header_path);
        if (typeof source.page_number === "number") metaParts.push("p. " + source.page_number);
        if (typeof source.score === "number") metaParts.push(Math.round(source.score * 100) + "%");
        if (metaParts.length > 0) {
          var meta = document.createElement("span");
          meta.className = "sn-ai-source-meta";
          meta.textContent = metaParts.join(" · ");
          row.appendChild(meta);
        }

        row.addEventListener("click", function () {
          if (window.SnAiSourcesModal && typeof window.SnAiSourcesModal.open === "function") {
            window.SnAiSourcesModal.open(source);
          }
        });
        list.appendChild(row);
      });
      listWrap.appendChild(list);
      refs.body.appendChild(listWrap);
    }

    refs.generateBtn.disabled = false;
    refs.generateBtn.classList.remove("sn-ai-loading");
    refs.generateBtn.innerHTML = ROBOT_SVG + '<span class="sn-ai-btn-label">Régénérer</span>';
    refs.status.textContent = "";

    // Wire up copy button: copy plain-text content of the rendered markdown
    refs.copyBtn.disabled = false;
    refs.copyBtn.onclick = function () {
      var clone = refs.body.cloneNode(true);
      // Drop the "Sources" list from the clipboard text
      var sourcesEl = clone.querySelector(".sn-ai-proposition-sources");
      if (sourcesEl) sourcesEl.remove();
      var plain = (clone.textContent || "").trim();
      navigator.clipboard.writeText(plain).then(function () {
        refs.status.textContent = "Copié !";
        setTimeout(function () { refs.status.textContent = ""; }, 1800);
      }).catch(function (err) {
        refs.status.textContent = "Échec de la copie : " + err.message;
      });
    };
  }

  // --- Streaming (token par token) ---

  function beginStream(host, options) {
    var refs = ensureSkeleton(host, options);
    refs.body._snSources = [];
    refs.body.innerHTML = "";
    refs.generateBtn.disabled = true;
    refs.generateBtn.classList.add("sn-ai-loading");
    refs.generateBtn.innerHTML = SPINNER_SVG + '<span class="sn-ai-btn-label">Génération…</span>';
    refs.status.textContent = "Recherche des sources…";
    refs.copyBtn.disabled = true;
    return refs;
  }

  // Re-render du texte accumulé à chaque chunk. Les sources (déjà connues, car
  // émises avant le texte) rendent les [N] cliquables immédiatement.
  function updateStream(host, fullText, sources) {
    var refs = getRefs(host);
    if (!refs) return;
    var srcs = Array.isArray(sources) ? sources : [];
    refs.body._snSources = srcs;
    refs.body.innerHTML = renderMarkdown(injectCitationPlaceholders(fullText || "", srcs));
    refs.status.textContent = "Génération en cours…";
  }

  // Rendu final : corps complet + liste des sources + copie/régénérer.
  function finishStream(host, fullText, sources, options) {
    render(host, { text: fullText, sources: sources }, options);
  }

  window.SnAiPropositionBox = {
    render: render,
    setEmpty: setEmpty,
    setLoading: setLoading,
    setError: setError,
    beginStream: beginStream,
    updateStream: updateStream,
    finishStream: finishStream,
  };
})();
