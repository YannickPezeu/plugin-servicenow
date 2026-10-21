// proposition-box.js — Box "Proposition IA" affichée sous la textarea SN.
// Rendue en markdown avec citations [N] cliquables qui ouvrent la modal source.
// Expose window.SnAiPropositionBox = { render(host, data), setLoading(host), setEmpty(host), setError(host, msg) }
// `options.feedback` ({ onSubmit(fb) → Promise, previous }) : panneau de retour à droite de la réponse.

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
        // corpus = toutes les sources → fallback si la citation pointe la mauvaise source
        window.SnAiSourcesModal.open(src, { quote: quote, corpus: sources });
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

    // Groupe Copier + menu déroulant au survol.
    // Clic direct sur "Copier" = sans les sources. Survol → choix du mode.
    var copyGroup = document.createElement("div");
    copyGroup.className = "sn-ai-copy-group";
    copyGroup.style.cssText = "position:relative;display:inline-block;";

    var copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "sn-ai-proposition-copy";
    copyBtn.title = "Copier — clic : sans les sources · survol : options";
    copyBtn.innerHTML = COPY_SVG + '<span class="sn-ai-btn-label">Copier ▾</span>';
    copyBtn.disabled = true; // enabled once content exists
    copyGroup.appendChild(copyBtn);

    var copyMenu = document.createElement("div");
    copyMenu.className = "sn-ai-copy-menu";
    copyMenu.style.cssText =
      "display:none;position:absolute;top:100%;right:0;z-index:20;min-width:240px;" +
      "background:#fff;border:1px solid #d0d7de;border-radius:6px;" +
      "box-shadow:0 4px 14px rgba(0,0,0,0.18);padding:4px;margin-top:2px;";
    [["none", "Sans les sources"],
     ["inline", "Sources inline (URL)"],
     ["links", "Sources en liens cliquables"]].forEach(function (opt) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "sn-ai-copy-menu-item";
      item.dataset.copyMode = opt[0];
      item.textContent = opt[1];
      item.style.cssText =
        "display:block;width:100%;text-align:left;border:none;background:none;" +
        "padding:6px 10px;font-size:12px;color:#333;cursor:pointer;border-radius:4px;white-space:nowrap;";
      item.addEventListener("mouseenter", function () { item.style.background = "#eef2f6"; });
      item.addEventListener("mouseleave", function () { item.style.background = "none"; });
      copyMenu.appendChild(item);
    });
    copyGroup.appendChild(copyMenu);

    copyGroup.addEventListener("mouseenter", function () { if (!copyBtn.disabled) copyMenu.style.display = "block"; });
    copyGroup.addEventListener("mouseleave", function () { copyMenu.style.display = "none"; });

    actions.appendChild(copyGroup);

    header.appendChild(actions);
    box.appendChild(header);

    // Search log (progression du streaming : requête, étapes, comptage site/KB)
    var log = document.createElement("div");
    log.className = "sn-ai-proposition-log";
    log.style.cssText = "display:none;font-size:11px;color:#6b7785;background:#f4f6f8;" +
      "border:1px solid #e1e7ed;border-radius:4px;padding:6px 8px;margin-bottom:8px;" +
      "max-height:90px;overflow:auto;white-space:pre-wrap;line-height:1.45;";
    box.appendChild(log);

    // Bulle de raisonnement : ce que le modèle se dit AVANT d'écrire, affiché
    // en parallèle de la rédaction. Repliée d'office dès que la réponse
    // commence — utile pour juger un cas litigieux, encombrant le reste du temps.
    var reasoning = document.createElement("div");
    reasoning.className = "sn-ai-proposition-reasoning";
    reasoning.style.cssText = "display:none;margin-bottom:8px;";

    var reasoningToggle = document.createElement("button");
    reasoningToggle.type = "button";
    reasoningToggle.className = "sn-ai-reasoning-toggle";
    reasoningToggle.style.cssText =
      "display:flex;align-items:center;gap:6px;width:100%;text-align:left;cursor:pointer;" +
      "border:1px solid #e1e7ed;border-radius:4px;background:#faf7f2;color:#8a6d3b;" +
      "font-size:11px;padding:5px 8px;";
    reasoning.appendChild(reasoningToggle);

    var reasoningText = document.createElement("div");
    reasoningText.className = "sn-ai-reasoning-text";
    reasoningText.style.cssText =
      "font-size:11px;color:#7a6a55;background:#faf7f2;border:1px solid #e1e7ed;border-top:none;" +
      "border-radius:0 0 4px 4px;padding:6px 8px;max-height:140px;overflow:auto;" +
      "white-space:pre-wrap;line-height:1.45;font-style:italic;";
    reasoning.appendChild(reasoningText);

    reasoningToggle.addEventListener("click", function () {
      reasoning._snUserToggled = true;
      setReasoningOpen(reasoning, reasoningText.style.display === "none");
    });

    box.appendChild(reasoning);

    // Body (state-dependent) + panneau de retour à sa droite. Le panneau est
    // HORS du body : la copie (clone du body) ne doit jamais l'emporter.
    var main = document.createElement("div");
    main.className = "sn-ai-proposition-main";
    var body = document.createElement("div");
    body.className = "sn-ai-proposition-body markdown";
    installCitationDelegation(body);
    main.appendChild(body);
    var feedback = buildFeedbackPanel();
    main.appendChild(feedback);
    box.appendChild(main);

    // Status footer (optional, for transient messages)
    var status = document.createElement("div");
    status.className = "sn-ai-proposition-status";
    box.appendChild(status);

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(box);

    return {
      box: box, generateBtn: generateBtn, copyBtn: copyBtn,
      body: body, status: status, log: log, reasoning: reasoning, feedback: feedback,
    };
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
      log: box.querySelector(".sn-ai-proposition-log"),
      reasoning: box.querySelector(".sn-ai-proposition-reasoning"),
      feedback: box.querySelector(".sn-ai-feedback"),
    };
  }

  // --- Panneau de retour : 👍/👎 (obligatoire), temps gagné et commentaire
  // (facultatifs). Envoyé à la page d'usage via le backend (background.js). ---

  function buildFeedbackPanel() {
    var panel = document.createElement("aside");
    panel.className = "sn-ai-feedback";
    panel.style.display = "none";
    panel.setAttribute("aria-label", "Votre avis sur la proposition");

    var title = document.createElement("div");
    title.className = "sn-ai-feedback-title";
    title.textContent = "Votre avis sur cette réponse";
    panel.appendChild(title);

    var thumbs = document.createElement("div");
    thumbs.className = "sn-ai-feedback-thumbs";
    [["up", "👍", "Réponse utile"], ["down", "👎", "Réponse pas utile"]].forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "sn-ai-feedback-thumb";
      b.dataset.rating = t[0];
      b.title = t[2];
      b.setAttribute("aria-label", t[2]);
      b.setAttribute("aria-pressed", "false");
      b.textContent = t[1];
      thumbs.appendChild(b);
    });
    panel.appendChild(thumbs);

    var timeLabel = document.createElement("label");
    timeLabel.className = "sn-ai-feedback-label";
    timeLabel.textContent = "Temps gagné estimé (min)";
    var time = document.createElement("input");
    time.type = "number";
    time.min = "0";
    time.max = "480";
    time.step = "1";
    time.inputMode = "numeric";
    time.placeholder = "facultatif";
    time.className = "sn-ai-feedback-time";
    timeLabel.appendChild(time);
    panel.appendChild(timeLabel);

    var commentLabel = document.createElement("label");
    commentLabel.className = "sn-ai-feedback-label";
    commentLabel.textContent = "Commentaire";
    var comment = document.createElement("textarea");
    comment.className = "sn-ai-feedback-comment";
    comment.rows = 4;
    comment.maxLength = 1000;
    comment.placeholder = "Facultatif. Ce qui manque, ce qui est faux… Pas de données personnelles.";
    commentLabel.appendChild(comment);
    panel.appendChild(commentLabel);

    var send = document.createElement("button");
    send.type = "button";
    send.className = "sn-ai-feedback-send";
    send.textContent = "Envoyer";
    send.disabled = true;
    panel.appendChild(send);

    var status = document.createElement("div");
    status.className = "sn-ai-feedback-status";
    status.setAttribute("role", "status");
    panel.appendChild(status);

    // Les touches tapées ici ne doivent pas remonter aux raccourcis clavier de SN.
    [time, comment].forEach(function (input) {
      input.addEventListener("keydown", function (e) { e.stopPropagation(); });
    });

    thumbs.addEventListener("click", function (e) {
      var b = e.target.closest(".sn-ai-feedback-thumb");
      if (!b) return;
      setRating(panel, b.dataset.rating);
      panel._snDirty = true;
      refreshSendState(panel);
    });
    [time, comment].forEach(function (input) {
      input.addEventListener("input", function () { panel._snDirty = true; refreshSendState(panel); });
    });
    send.addEventListener("click", function () { submitFeedback(panel); });
    return panel;
  }

  function setRating(panel, rating) {
    panel._snRating = rating || null;
    panel.querySelectorAll(".sn-ai-feedback-thumb").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.rating === rating));
    });
  }

  function readTime(panel) {
    var raw = panel.querySelector(".sn-ai-feedback-time").value.trim();
    if (raw === "") return { ok: true, value: null };
    var n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 480) return { ok: false };
    return { ok: true, value: n };
  }

  function refreshSendState(panel) {
    var send = panel.querySelector(".sn-ai-feedback-send");
    var status = panel.querySelector(".sn-ai-feedback-status");
    var time = readTime(panel);
    if (!time.ok) {
      status.textContent = "Temps gagné : un nombre entier de 0 à 480 minutes.";
      status.className = "sn-ai-feedback-status sn-ai-feedback-error";
    } else if (panel._snDirty && status.classList.contains("sn-ai-feedback-error")) {
      status.textContent = "";
      status.className = "sn-ai-feedback-status";
    }
    send.disabled = panel._snSending || !panel._snRating || !time.ok || !panel._snDirty;
  }

  function submitFeedback(panel) {
    var opts = panel._snOptions;
    var time = readTime(panel);
    if (!opts || !panel._snRating || !time.ok) return;
    var fb = {
      rating: panel._snRating,
      timeSavedMin: time.value,
      comment: panel.querySelector(".sn-ai-feedback-comment").value.trim(),
    };
    var send = panel.querySelector(".sn-ai-feedback-send");
    var status = panel.querySelector(".sn-ai-feedback-status");
    panel._snSending = true;
    refreshSendState(panel);
    status.className = "sn-ai-feedback-status";
    status.textContent = "Envoi…";
    Promise.resolve(opts.onSubmit(fb)).then(function () {
      panel._snSent = true;
      panel._snDirty = false;
      status.textContent = "Merci, votre retour est enregistré.";
      send.textContent = "Modifier le retour";
    }, function (err) {
      status.className = "sn-ai-feedback-status sn-ai-feedback-error";
      status.textContent = (err && err.message) || "Échec de l'envoi.";
    }).then(function () {
      panel._snSending = false;
      refreshSendState(panel);
    });
  }

  // Affiche le panneau pour une génération (options.feedback de content.js),
  // pré-rempli si l'agent a déjà donné son avis ; le masque sinon.
  function showFeedback(refs, fbOptions) {
    var panel = refs.feedback;
    if (!panel) return;
    if (!fbOptions || typeof fbOptions.onSubmit !== "function") {
      hideFeedback(refs);
      return;
    }
    panel._snOptions = fbOptions;
    var prev = fbOptions.previous;
    setRating(panel, prev ? prev.rating : null);
    panel.querySelector(".sn-ai-feedback-time").value =
      prev && typeof prev.timeSavedMin === "number" ? String(prev.timeSavedMin) : "";
    panel.querySelector(".sn-ai-feedback-comment").value = (prev && prev.comment) || "";
    panel._snSent = !!prev;
    panel._snDirty = false;
    panel._snSending = false;
    var status = panel.querySelector(".sn-ai-feedback-status");
    status.className = "sn-ai-feedback-status";
    status.textContent = prev ? "Retour déjà envoyé — vous pouvez le modifier." : "";
    panel.querySelector(".sn-ai-feedback-send").textContent = prev ? "Modifier le retour" : "Envoyer";
    panel.style.display = "";
    refreshSendState(panel);
  }

  function hideFeedback(refs) {
    if (refs.feedback) {
      refs.feedback.style.display = "none";
      refs.feedback._snOptions = null;
    }
  }

  // --- Bulle de raisonnement ---

  function setReasoningOpen(reasoning, open) {
    var text = reasoning.querySelector(".sn-ai-reasoning-text");
    text.style.display = open ? "block" : "none";
    reasoning.querySelector(".sn-ai-reasoning-toggle").style.borderRadius = open ? "4px 4px 0 0" : "4px";
    renderReasoningLabel(reasoning);
    if (open) text.scrollTop = text.scrollHeight;
  }

  function renderReasoningLabel(reasoning) {
    var toggle = reasoning.querySelector(".sn-ai-reasoning-toggle");
    var open = reasoning.querySelector(".sn-ai-reasoning-text").style.display !== "none";
    var chars = (reasoning._snText || "").length;
    var seconds = reasoning._snStart
      ? Math.round(((reasoning._snEnd || Date.now()) - reasoning._snStart) / 1000)
      : 0;
    var meta = reasoning._snEnd
      ? seconds + " s · " + chars.toLocaleString("fr-CH") + " caractères"
      : "en cours…";
    toggle.textContent = (open ? "▾" : "▸") + " Raisonnement du modèle — " + meta;
  }

  // Le raisonnement arrive avant (et pendant) la réponse. Il vit dans sa propre
  // bulle : il n'entre jamais dans le corps de la proposition, donc jamais dans
  // ce que l'agent copie ou envoie à l'usager.
  function updateReasoning(host, text) {
    var refs = getRefs(host);
    if (!refs || !refs.reasoning) return;
    var reasoning = refs.reasoning;
    if (!reasoning._snStart) {
      reasoning._snStart = Date.now();
      reasoning.style.display = "block";
      setReasoningOpen(reasoning, true);
    }
    reasoning._snText = text;
    if (refs.status && !refs.body.textContent) refs.status.textContent = "Réflexion du modèle…";
    var el = reasoning.querySelector(".sn-ai-reasoning-text");
    var stuckToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    el.textContent = text;
    if (stuckToBottom) el.scrollTop = el.scrollHeight;
    renderReasoningLabel(reasoning);
  }

  // Premier jeton de réponse : le raisonnement est terminé, on le replie (sauf
  // si l'agent l'a ouvert ou fermé lui-même — son choix prime).
  function sealReasoning(refs) {
    var reasoning = refs.reasoning;
    if (!reasoning || !reasoning._snStart || reasoning._snEnd) return;
    reasoning._snEnd = Date.now();
    if (!reasoning._snUserToggled) setReasoningOpen(reasoning, false);
    else renderReasoningLabel(reasoning);
  }

  function resetReasoning(refs) {
    var reasoning = refs.reasoning;
    if (!reasoning) return;
    reasoning._snStart = null;
    reasoning._snEnd = null;
    reasoning._snText = "";
    reasoning._snUserToggled = false;
    reasoning.querySelector(".sn-ai-reasoning-text").textContent = "";
    reasoning.style.display = "none";
  }

  function ensureSkeleton(host, options) {
    var refs = getRefs(host);
    if (refs) return refs;
    return buildBoxSkeleton(host, options);
  }

  function setEmpty(host, options) {
    var refs = ensureSkeleton(host, options);
    // Réponse vide apres une longue reflexion : la bulle reste, figée. C'est
    // précisément le cas où le raisonnement explique ce qui s'est passé.
    sealReasoning(refs);
    hideFeedback(refs);
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
    // Panne pendant la réflexion : on fige la bulle plutôt que de la laisser
    // afficher « en cours… » indéfiniment. Elle reste consultable — c'est
    // souvent là que se lit la raison de l'échec.
    sealReasoning(refs);
    hideFeedback(refs);
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
    sealReasoning(refs);
    var text = (data && data.text) || "";
    var sources = (data && Array.isArray(data.sources)) ? data.sources : [];

    if (!text.trim()) {
      setEmpty(host, options);
      return;
    }

    refs.body._snSources = sources;
    refs.body.innerHTML = renderMarkdown(injectCitationPlaceholders(text, sources));
    showFeedback(refs, options && options.feedback);

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

    // Copie : 3 modes (sans sources / sources inline URL / sources en liens cliquables).
    refs.copyBtn.disabled = false;

    // URL d'une source : http(s) seulement (le backend renvoie "URL not found"
    // pour les sources sans lien → ignorées) ; + #page=N pour les PDF.
    function _citeUrl(s) {
      var u = s && s.source_url ? s.source_url : "";
      if (!/^https?:\/\//i.test(u)) return "";
      if (s.file_type === "pdf" && typeof s.page_number === "number" && !/[#&]page=/.test(u)) {
        u += (u.indexOf("#") !== -1 ? "&" : "#") + "page=" + s.page_number;
      }
      return u;
    }

    function _doCopy(mode) {
      var clone = refs.body.cloneNode(true);
      var sourcesEl = clone.querySelector(".sn-ai-proposition-sources");
      if (sourcesEl) sourcesEl.remove();

      var byNum = {};
      (refs.body._snSources || []).forEach(function (s) { byNum[s.number] = s; });
      var cites = clone.querySelectorAll(".sn-ai-citation");

      if (mode === "none") {
        cites.forEach(function (b) { b.remove(); });
      } else if (mode === "inline") {
        cites.forEach(function (b) {
          var u = _citeUrl(byNum[parseInt(b.getAttribute("data-source-num"), 10)]);
          b.replaceWith(document.createTextNode(u ? " (" + u + ")" : ""));
        });
      } else { // "links" : on garde [N], cliquable (HTML) vers l'URL
        cites.forEach(function (b) {
          var num = parseInt(b.getAttribute("data-source-num"), 10);
          var u = _citeUrl(byNum[num]);
          if (u) {
            var a = document.createElement("a");
            a.href = u;
            a.textContent = "[" + num + "]";
            b.replaceWith(a);
          } else {
            b.replaceWith(document.createTextNode("[" + num + "]"));
          }
        });
      }

      var done = function () {
        refs.status.textContent = "Copié !";
        setTimeout(function () { refs.status.textContent = ""; }, 1800);
      };
      var fail = function (err) {
        refs.status.textContent = "Échec de la copie : " + ((err && err.message) || err);
      };

      var text = (clone.textContent || "").replace(/[ \t]{2,}/g, " ").trim();
      if (mode === "links" && window.ClipboardItem && navigator.clipboard.write) {
        // text/html → liens cliquables dans l'éditeur HTML ; text/plain → fallback champ simple.
        navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([clone.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        })]).then(done).catch(fail);
      } else {
        navigator.clipboard.writeText(text).then(done).catch(fail);
      }
    }

    refs.copyBtn.onclick = function () { _doCopy("none"); };
    refs.box.querySelectorAll(".sn-ai-copy-menu-item").forEach(function (item) {
      item.onclick = function (e) {
        e.stopPropagation();
        _doCopy(item.dataset.copyMode);
        var m = refs.box.querySelector(".sn-ai-copy-menu");
        if (m) m.style.display = "none";
      };
    });
  }

  // --- Streaming (token par token) ---

  function beginStream(host, options) {
    var refs = ensureSkeleton(host, options);
    refs.body._snSources = [];
    refs.body.innerHTML = "";
    if (refs.log) { refs.log.textContent = ""; refs.log.style.display = "none"; }
    resetReasoning(refs);
    hideFeedback(refs);
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
    if (fullText) sealReasoning(refs);
    var srcs = Array.isArray(sources) ? sources : [];
    refs.body._snSources = srcs;
    refs.body.innerHTML = renderMarkdown(injectCitationPlaceholders(fullText || "", srcs));
    refs.status.textContent = "Génération en cours…";
  }

  // Rendu final : corps complet + liste des sources + copie/régénérer.
  // Le log de recherche reste visible (utile pour juger query/pertinence).
  function finishStream(host, fullText, sources, options) {
    render(host, { text: fullText, sources: sources }, options);
  }

  // Ajoute une ligne au log de recherche (requête, étapes, comptage).
  function logProgress(host, message) {
    var refs = getRefs(host);
    if (!refs || !refs.log || !message) return;
    refs.log.style.display = "block";
    var line = document.createElement("div");
    line.textContent = "• " + message;
    refs.log.appendChild(line);
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  window.SnAiPropositionBox = {
    render: render,
    setEmpty: setEmpty,
    setLoading: setLoading,
    setError: setError,
    beginStream: beginStream,
    updateStream: updateStream,
    updateReasoning: updateReasoning,
    finishStream: finishStream,
    logProgress: logProgress,
  };
})();
