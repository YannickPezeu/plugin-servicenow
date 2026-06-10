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

  function injectPropositionBoxForTextarea(config) {
    if (BOXES_INJECTED.has(config.id)) return;

    var textarea = document.getElementById(config.id);
    if (!textarea) return;

    var container = textarea.closest(".sn-stream-textarea-container") || textarea.parentElement;
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
      inFlight = true;
      window.SnAiPropositionBox.setLoading(host, { onGenerate: onGenerate });

      var context = extractTicketContext();
      console.log("[SN AI Plugin] Generating proposition, context:", context);

      callRagApi(context)
        .then(function (result) {
          inFlight = false;
          window.SnAiPropositionBox.render(host, result, { onGenerate: onGenerate });
          saveResultToCache(sysId, result, context.short_description);
        })
        .catch(function (err) {
          inFlight = false;
          console.error("[SN AI Plugin] API error:", err);
          var msg = err && err.message ? err.message : String(err);
          window.SnAiPropositionBox.setError(host, msg, { onGenerate: onGenerate });
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

    function createPrecomputeButton() {
      var btn = document.createElement("button");
      btn.id = "sn-ai-precompute-btn";
      btn.type = "button";
      btn.textContent = "Precompute IA";
      btn.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:99999;" +
        "padding:10px 16px;border:none;border-radius:6px;" +
        "background-color:#4a6785;color:#fff;font-size:13px;font-weight:600;" +
        "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3);";

      btn.addEventListener("click", function () {
        precomputeTriggered = false; // allow re-trigger
        triggerPrecompute();
      });

      document.body.appendChild(btn);
    }

    if (document.body) {
      createPrecomputeButton();
    } else {
      document.addEventListener("DOMContentLoaded", createPrecomputeButton);
    }
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
