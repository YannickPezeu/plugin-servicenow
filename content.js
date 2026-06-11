// content.js — Content script injected into all frames on *.service-now.com
// Detects the activity stream textareas and adds "Générer IA" buttons

(function () {
  "use strict";

  // --- API Configuration ---
  var API_LIBRARY = "large_campus2";
  var DEFAULTS = {
    rerank: true,
    model: "moonshotai/Kimi-K2.6",
    topK: 10,
    indexKey: "",
  };

  var INJECT_SCRIPT_LOADED = false;
  var BOXES_INJECTED = new Set();
  var PROPOSITION_HOSTS = new Map(); // textareaId -> host element
  var precomputeTriggered = false;

  // Textarea configurations — IDs of the SN textareas we anchor below.
  var TEXTAREA_CONFIGS = [
    { id: "activity-stream-comments-textarea" },
  ];

  function injectMainWorldScript() {
    if (INJECT_SCRIPT_LOADED) return;
    var script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = function () {
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
    INJECT_SCRIPT_LOADED = true;
  }

  // --- Extract ticket context from ServiceNow DOM ---

  function getFieldValue(names) {
    // Try multiple selectors to find a field value
    for (var i = 0; i < names.length; i++) {
      var el =
        document.getElementById(names[i]) ||
        document.querySelector('[name="' + names[i] + '"]') ||
        document.querySelector('[id*="' + names[i] + '"]');
      if (el) {
        return (el.value || el.textContent || "").trim();
      }
    }
    return "";
  }

  function extractPreviousMessages() {
    var messages = [];
    // ServiceNow classic UI activity stream journal entries
    var entries = document.querySelectorAll(
      ".sn-widget-list-table-cell .journal-entry-wrapper," +
      ".sn-widget-list-table-cell .sn-widget-textblock-body," +
      ".journal_entry_wrapper," +
      '[data-activity-type] .sn-widget-textblock-body'
    );
    entries.forEach(function (entry) {
      var text = (entry.textContent || "").trim();
      if (!text) return;
      // Try to determine sender from parent context
      var parent = entry.closest("[data-activity-type]") || entry.closest("tr");
      var sender = "agent_support";
      if (parent) {
        var label = parent.textContent || "";
        if (/client|customer|utilisateur|demandeur/i.test(label)) {
          sender = "client";
        }
      }
      messages.push({ sender: sender, content: text });
    });
    return messages;
  }

  function extractTicketContext() {
    var shortDesc = getFieldValue([
      "incident.short_description",
      "short_description",
      "sys_display.incident.short_description",
    ]);
    var description = getFieldValue([
      "incident.description",
      "description",
      "incident.description.text",
    ]);
    var previousMessages = extractPreviousMessages();

    return {
      short_description: shortDesc || "Ticket ServiceNow",
      description: description || shortDesc || "",
      previous_messages: previousMessages,
    };
  }

  // --- Call RAG API ---

  var CONTEXT_INVALIDATED_MSG =
    "Le plugin a ete deconnecte (mise a jour ou inactivite prolongee).\n" +
    "Veuillez rafraichir la page (F5) pour reactiver le bouton IA.";

  function isContextInvalidated() {
    try {
      return !chrome.runtime || !chrome.runtime.id;
    } catch (e) {
      return true;
    }
  }

  function callRagApi(context) {
    // Check early if extension context is still valid
    if (isContextInvalidated()) {
      return Promise.reject(new Error(CONTEXT_INVALIDATED_MSG));
    }

    return new Promise(function (resolve, reject) {
      // Read rerank setting from storage
      chrome.storage.local.get(DEFAULTS, function (settings) {
        if (chrome.runtime.lastError || isContextInvalidated()) {
          reject(new Error(CONTEXT_INVALIDATED_MSG));
          return;
        }

        var payload = {
          description: context.description,
          short_description: context.short_description,
          previous_messages: context.previous_messages,
          library: API_LIBRARY,
          model: settings.model,
          top_k: settings.topK,
          temperature: 0.3,
          rerank: settings.rerank,
        };

        chrome.runtime.sendMessage(
          { type: "rag-generate", payload: payload, sysId: getSysIdFromUrl() },
          function (response) {
            if (chrome.runtime.lastError) {
              var errMsg = chrome.runtime.lastError.message || "";
              if (/context invalidated|disconnected/i.test(errMsg)) {
                reject(new Error(CONTEXT_INVALIDATED_MSG));
              } else {
                reject(new Error(errMsg));
              }
            } else if (response && response.success) {
              resolve({ text: response.text, sources: response.sources || [] });
            } else {
              reject(new Error(response ? response.error : "No response"));
            }
          }
        );
      });
    });
  }

  // --- Save a manually-generated response into the cache (so refresh keeps it) ---

  function saveResultToCache(sysId, result, shortDescription) {
    if (!sysId) return;
    chrome.storage.local.get({ precomputeCache: {} }, function (data) {
      var cache = data.precomputeCache;
      var prev = cache[sysId] || {};
      cache[sysId] = {
        // Hash is "manual" so the next periodic precompute will re-fetch and
        // overwrite with the up-to-date hash from background.
        hash: "manual",
        response: result.text,
        sources: result.sources,
        schemaVersion: 2,
        timestamp: Date.now(),
        shortDescription: prev.shortDescription || shortDescription || "",
      };
      chrome.storage.local.set({ precomputeCache: cache });
    });
  }

  // --- Inject the autonomous "Proposition IA" box below a textarea ---

  // Trouve l'élément après lequel insérer la box, selon le mode d'édition du
  // champ commentaire (le champ "Commentaires visibles par les clients") :
  //   - Éditeur HTML décoché → textarea simple `activity-stream-comments-textarea`
  //   - Éditeur HTML coché    → éditeur TinyMCE (iframe `…comment…_ifr`), conteneur `.tox-tinymce`
  // La textarea existe dans les deux modes (cachée en mode HTML), on privilégie
  // donc l'élément réellement visible.
  function findCommentInsertionPoint() {
    var ta = document.getElementById("activity-stream-comments-textarea");
    if (ta && ta.offsetParent !== null) {
      return ta.closest(".sn-stream-textarea-container") || ta.parentElement;
    }
    // Mode éditeur HTML : iframe TinyMCE du champ commentaires (exclut work_notes)
    var ifr = document.querySelector('iframe[id$="_ifr"][id*="comment" i]');
    if (ifr) {
      var box = ifr.closest(".tox-tinymce, .mce-tinymce") || ifr.parentElement;
      if (box && box.parentElement) return box;
    }
    if (ta) return ta.closest(".sn-stream-textarea-container") || ta.parentElement;
    return null;
  }

  function injectPropositionBoxForTextarea(config) {
    // Ré-injecter si la box a disparu : ServiceNow re-render le formulaire en AJAX
    // et retire notre host. On se base sur la présence RÉELLE du host dans le DOM
    // (isConnected), pas sur un flag "déjà fait" — sinon, après un re-render, la
    // box ne réapparaît jamais (cas observé chez certains utilisateurs).
    var existingHost = PROPOSITION_HOSTS.get(config.id);
    if (existingHost && existingHost.isConnected) return;

    var container = findCommentInsertionPoint();
    if (!container || !container.parentElement) return;

    var host = document.createElement("div");
    host.className = "sn-ai-proposition-host";
    host.dataset.textareaId = config.id;
    container.parentElement.insertBefore(host, container.nextSibling);
    PROPOSITION_HOSTS.set(config.id, host);

    var sysId = getSysIdFromUrl();
    var inFlight = false;

    function onGenerate() {
      if (inFlight) return;
      if (isContextInvalidated()) return;
      inFlight = true;
      var opts = { onGenerate: onGenerate };
      window.SnAiPropositionBox.beginStream(host, opts);

      var context = extractTicketContext();
      console.log("[SN AI Plugin] Generating proposition (stream), context:", context);

      chrome.storage.local.get(DEFAULTS, function (settings) {
        if (chrome.runtime.lastError || isContextInvalidated()) {
          inFlight = false;
          window.SnAiPropositionBox.setError(host, CONTEXT_INVALIDATED_MSG, opts);
          return;
        }

        var payload = {
          description: context.description,
          short_description: context.short_description,
          previous_messages: context.previous_messages, // écrasé côté backend via l'API journal
          library: API_LIBRARY,
          model: settings.model,
          top_k: settings.topK,
          temperature: 0.3,
          rerank: settings.rerank,
        };

        var port = chrome.runtime.connect({ name: "rag-stream" });
        var fullText = "";
        var sources = [];
        var finished = false;

        port.onMessage.addListener(function (msg) {
          if (msg.type === "chunk") {
            fullText += msg.text;
            window.SnAiPropositionBox.updateStream(host, fullText, sources);
          } else if (msg.type === "sources") {
            sources = msg.sources || [];
            window.SnAiPropositionBox.updateStream(host, fullText, sources);
          } else if (msg.type === "progress") {
            window.SnAiPropositionBox.logProgress(host, msg.message);
          } else if (msg.type === "error") {
            finished = true;
            inFlight = false;
            window.SnAiPropositionBox.setError(host, msg.error, opts);
            try { port.disconnect(); } catch (e) {}
          } else if (msg.type === "done") {
            if (finished) return;
            finished = true;
            inFlight = false;
            if (fullText.trim()) {
              window.SnAiPropositionBox.finishStream(host, fullText, sources, opts);
              saveResultToCache(sysId, { text: fullText, sources: sources }, context.short_description);
            } else {
              window.SnAiPropositionBox.setEmpty(host, opts);
            }
            try { port.disconnect(); } catch (e) {}
          }
        });

        port.onDisconnect.addListener(function () {
          if (finished) return;
          finished = true;
          inFlight = false;
          var err = chrome.runtime.lastError;
          window.SnAiPropositionBox.setError(host, (err && err.message) || "Connexion interrompue.", opts);
        });

        port.postMessage({ type: "rag-generate", payload: payload, sysId: getSysIdFromUrl() });
      });
    }

    // Initial state: try cache first, else show empty state
    if (sysId) {
      chrome.storage.local.get({ precomputeCache: {} }, function (data) {
        var cached = data.precomputeCache[sysId];
        if (cached && cached.response && Array.isArray(cached.sources)) {
          window.SnAiPropositionBox.render(host, {
            text: cached.response,
            sources: cached.sources,
          }, { onGenerate: onGenerate });
          console.log("[SN AI Plugin] Proposition rendered from cache for", sysId,
            "| sources:", cached.sources.length);
        } else {
          window.SnAiPropositionBox.setEmpty(host, { onGenerate: onGenerate });
          if (cached && cached.response && !Array.isArray(cached.sources)) {
            console.log("[SN AI Plugin] Cache entry is v1 (no sources), showing empty state");
          }
        }
      });
    } else {
      window.SnAiPropositionBox.setEmpty(host, { onGenerate: onGenerate });
    }

    BOXES_INJECTED.add(config.id);
    console.log("[SN AI Plugin] Proposition box injected for", config.id);
  }

  function tryInjectPropositionBoxes() {
    TEXTAREA_CONFIGS.forEach(function (config) {
      injectPropositionBoxForTextarea(config);
    });
  }

  // --- Precompute: trigger from top frame ---

  function getSysIdFromUrl() {
    var match = window.location.search.match(/sys_id=([a-f0-9]{32})/);
    return match ? match[1] : null;
  }

  var isTopFrame = (window === window.top);
  var isTicketPage = /incident\.do/.test(window.location.pathname) && getSysIdFromUrl();

  console.log("[SN AI Plugin] Frame info:", {
    isTopFrame: isTopFrame,
    isTicketPage: !!isTicketPage,
    pathname: window.location.pathname,
    sysId: getSysIdFromUrl(),
    href: window.location.href.substring(0, 120),
  });

  // Signal background on every SN page navigation (background handles debounce)
  if (!isContextInvalidated()) {
    chrome.runtime.sendMessage({ type: "sn-page-loaded" }, function () {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }

  // Top frame: inject script immediately to capture g_ck, add precompute button
  if (isTopFrame) {
    injectMainWorldScript();

    function triggerPrecompute() {
      var gck = document.documentElement.getAttribute("data-sn-ai-gck");
      if (!gck) {
        console.warn("[SN AI Plugin] g_ck not found on page");
        return;
      }

      if (isContextInvalidated()) {
        console.warn("[SN AI Plugin] Extension context invalidated");
        return;
      }

      chrome.storage.local.get({ assignmentGroup: "" }, function (settings) {
        if (chrome.runtime.lastError) {
          console.error("[SN AI Plugin] Storage error:", chrome.runtime.lastError);
          return;
        }
        if (!settings.assignmentGroup) {
          console.warn("[SN AI Plugin] No assignment group configured");
          updatePrecomputeButton("no-group");
          return;
        }

        console.log("[SN AI Plugin] Precompute triggered for group:", settings.assignmentGroup);
        updatePrecomputeButton("loading");

        chrome.runtime.sendMessage({
          type: "precompute-init",
          gck: gck,
          origin: window.location.origin,
          assignmentGroup: settings.assignmentGroup,
        }, function (response) {
          if (chrome.runtime.lastError) {
            console.error("[SN AI Plugin] Message error:", chrome.runtime.lastError);
            updatePrecomputeButton("error");
          } else {
            console.log("[SN AI Plugin] Precompute init response:", response);
            updatePrecomputeButton("done");
          }
        });
      });
    }

    // Auto-trigger when g_ck is available
    document.addEventListener("sn-ai-gck", function () {
      // Persist g_ck + origin for background periodic precompute
      var gck = document.documentElement.getAttribute("data-sn-ai-gck");
      if (gck && !isContextInvalidated()) {
        chrome.storage.local.set({
          snGck: gck,
          snOrigin: window.location.origin,
          snGckTimestamp: Date.now(),
        });
        console.log("[SN AI Plugin] g_ck persisted for background precompute");
      }

      if (precomputeTriggered) return;
      precomputeTriggered = true;
      triggerPrecompute();
    });

    // Precompute button in top frame
    function updatePrecomputeButton(state) {
      var btn = document.getElementById("sn-ai-precompute-btn");
      if (!btn) return;
      if (state === "loading") {
        btn.textContent = "Precompute...";
        btn.style.backgroundColor = "#f0ad4e";
        btn.disabled = true;
      } else if (state === "done") {
        btn.textContent = "Precompute OK";
        btn.style.backgroundColor = "#5cb85c";
        btn.disabled = false;
      } else if (state === "error") {
        btn.textContent = "Precompute ERR";
        btn.style.backgroundColor = "#d9534f";
        btn.disabled = false;
      } else if (state === "no-group") {
        btn.textContent = "Pas de groupe";
        btn.style.backgroundColor = "#d9534f";
        btn.disabled = false;
      }
    }

    // Bouton flottant de précompute retiré (debug). Le précompute s'auto-déclenche
    // via l'événement `sn-ai-gck` ci-dessus — pas besoin d'UI visible.
  }

  // --- Proposition box injection (runs in ticket iframes) ---

  // Initial attempt
  tryInjectPropositionBoxes();

  // Observe DOM changes (ServiceNow loads content dynamically)
  var observer = new MutationObserver(function () {
    tryInjectPropositionBoxes();
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Also retry periodically for the first 30 seconds (some SN pages load slowly)
  var retryCount = 0;
  var retryInterval = setInterval(function () {
    tryInjectPropositionBoxes();
    retryCount++;
    if (retryCount > 30 || BOXES_INJECTED.size >= TEXTAREA_CONFIGS.length) {
      clearInterval(retryInterval);
    }
  }, 1000);
})();
