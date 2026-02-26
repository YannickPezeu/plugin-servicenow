// content.js — Content script injected into all frames on *.service-now.com
// Detects the activity stream textareas and adds "Générer IA" buttons

(function () {
  "use strict";

  // --- API Configuration ---
  var API_LIBRARY = "finance_embeddings";
  var DEFAULTS = {
    rerank: true,
    model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506-bfloat16",
    topK: 10,
  };

  var INJECT_SCRIPT_LOADED = false;
  var BUTTONS_INJECTED = new Set();

  // Textarea configurations
  var TEXTAREA_CONFIGS = [
    {
      id: "activity-stream-comments-textarea",
      scopeField: "activity_field_0.value",
      label: "Générer IA",
    },
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

  function triggerAiFill(textareaId, scopeField, message) {
    injectMainWorldScript();

    // Small delay to ensure inject.js is loaded
    setTimeout(function () {
      document.dispatchEvent(
        new CustomEvent("servicenow-ai-fill", {
          detail: {
            textareaId: textareaId,
            scopeField: scopeField,
            message: message,
          },
        })
      );
    }, 100);
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
          { type: "rag-generate", payload: payload },
          function (response) {
            if (chrome.runtime.lastError) {
              var errMsg = chrome.runtime.lastError.message || "";
              if (/context invalidated|disconnected/i.test(errMsg)) {
                reject(new Error(CONTEXT_INVALIDATED_MSG));
              } else {
                reject(new Error(errMsg));
              }
            } else if (response && response.success) {
              resolve(response.text);
            } else {
              reject(new Error(response ? response.error : "No response"));
            }
          }
        );
      });
    });
  }

  // SVG robot icon
  var ROBOT_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="40" height="40">' +
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
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="40" height="40" class="sn-ai-spinner-svg">' +
    '<circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.3)" stroke-width="3"/>' +
    '<path d="M12 3a9 9 0 0 1 9 9" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' +
    "</svg>";

  var WARNING_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="40" height="40">' +
    '<path d="M12 2L1 21h22L12 2z" fill="#fff"/>' +
    '<path d="M12 5l8.66 15H3.34L12 5z" fill="currentColor"/>' +
    '<rect x="11" y="10" width="2" height="5" rx="0.5" fill="#fff"/>' +
    '<circle cx="12" cy="17.5" r="1.2" fill="#fff"/>' +
    "</svg>";

  function createAiButton(config) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sn-ai-generate-btn";
    btn.innerHTML = ROBOT_SVG;
    btn.title = "Générer une réponse IA pour ce champ";

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();

      btn.disabled = true;
      btn.classList.add("sn-ai-loading");
      btn.innerHTML = SPINNER_SVG;

      var context = extractTicketContext();
      console.log("[SN AI Plugin] Ticket context:", context);

      callRagApi(context)
        .then(function (responseText) {
          triggerAiFill(config.id, config.scopeField, responseText);
        })
        .catch(function (err) {
          console.error("[SN AI Plugin] API error:", err);
          if (err.message === CONTEXT_INVALIDATED_MSG) {
            // Show persistent warning state on button
            btn.classList.add("sn-ai-disconnected");
            btn.innerHTML = WARNING_SVG;
            btn.title = "Plugin deconnecte — rafraichissez la page (F5)";
            // Don't re-enable normally, keep warning state
            btn.disabled = false;
            btn.classList.remove("sn-ai-loading");
            return;
          }
          triggerAiFill(
            config.id,
            config.scopeField,
            "[Erreur IA] Impossible de contacter l'API: " + err.message
          );
        })
        .finally(function () {
          if (btn.classList.contains("sn-ai-disconnected")) return;
          // Re-enable button after a short delay to let inject.js finish
          setTimeout(function () {
            btn.disabled = false;
            btn.classList.remove("sn-ai-loading");
            btn.innerHTML = ROBOT_SVG;
          }, 500);
        });
    });

    return btn;
  }

  function injectButtonForTextarea(config) {
    if (BUTTONS_INJECTED.has(config.id)) return;

    var textarea = document.getElementById(config.id);
    if (!textarea) return;

    // Find the container to attach the button
    var container = textarea.closest(".sn-stream-textarea-container");
    if (!container) {
      container = textarea.parentElement;
    }

    var btn = createAiButton(config);

    // Wrap the textarea container in a flex row with the button on the left
    var wrapper = document.createElement("div");
    wrapper.className = "sn-ai-row-wrapper";
    container.parentElement.insertBefore(wrapper, container);
    wrapper.appendChild(btn);
    wrapper.appendChild(container);

    BUTTONS_INJECTED.add(config.id);
    console.log("[SN AI Plugin] Button injected for", config.id);
  }

  function tryInjectButtons() {
    TEXTAREA_CONFIGS.forEach(function (config) {
      injectButtonForTextarea(config);
    });
  }

  // Initial attempt
  tryInjectButtons();

  // Observe DOM changes (ServiceNow loads content dynamically)
  var observer = new MutationObserver(function () {
    tryInjectButtons();
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Also retry periodically for the first 30 seconds (some SN pages load slowly)
  var retryCount = 0;
  var retryInterval = setInterval(function () {
    tryInjectButtons();
    retryCount++;
    if (retryCount > 30 || BUTTONS_INJECTED.size >= TEXTAREA_CONFIGS.length) {
      clearInterval(retryInterval);
    }
  }, 1000);
})();
