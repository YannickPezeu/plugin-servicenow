// background.js — Service worker that proxies API calls (bypasses CORS)

importScripts("oidc.js");

var API_URL = "https://hierarchical-search.epfl.ch/rag/servicenow/generate";
var API_KEY_DEFAULT = "";
// Ignoré par /rag/servicenow/generate (source imposée : site + KB ServiceNow OBO),
// gardé pour le champ `library_used`/logs côté backend.
var API_LIBRARY = "servicenow_obo";

// Note: the LLM system prompt lives server-side (DEFAULT_ANSWER_SYSTEM_PROMPT
// in Hierarchical_search/full_RAG_api/core/prompts.py) — it dictates the
// `[N: "verbatim quote"]` citation format that this extension parses.

// --- Shared utilities ---

var CACHE_SCHEMA_VERSION = 2;

function buildResponsePayload(answer, sources) {
  var list = Array.isArray(sources) ? sources : [];

  var cited = new Set();
  // Matches both [N] (legacy) and [N: "verbatim quote"] (DPO-style)
  var regex = /\[(\d+)(?::\s*"[^"]*")?\]/g;
  var match;
  while ((match = regex.exec(answer)) !== null) {
    cited.add(parseInt(match[1], 10));
  }

  var enriched = list.map(function (src, i) {
    var num = i + 1;
    return {
      number: num,
      title: (src.title || "Source " + num).replace(/\.md$/, ""),
      source_url: src.source_url || "",
      score: typeof src.score === "number" ? src.score : null,
      snippet: src.snippet || "",
      precise_content: src.precise_content || src.snippet || "",
      // context_content (chunk parent large) is what the LLM saw and what the
      // modal must display so that [N: "quote"] highlight finds the phrase.
      context_content: src.context_content || src.precise_content || src.snippet || "",
      header_path: src.header_path || "",
      page_number: typeof src.page_number === "number" ? src.page_number : null,
      file_type: src.file_type || "",
      search_text_start: src.search_text_start || "",
      search_text_end: src.search_text_end || "",
      cited: cited.has(num),
    };
  });

  return { text: answer, sources: enriched };
}

// Builds RAG request headers, adding Bearer token if user is signed in via OIDC.
function buildRagHeaders(apiKey) {
  return oidcGetIdToken().then(function (idToken) {
    var headers = {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    };
    if (idToken) headers["Authorization"] = "Bearer " + idToken;
    return headers;
  });
}

function simpleHash(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    var chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

// --- Precompute queue ---

var PRECOMPUTE_CONCURRENCY = 20;
var precomputeQueue = [];
var precomputeActive = 0;

function processPrecomputeQueue() {
  while (precomputeActive < PRECOMPUTE_CONCURRENCY && precomputeQueue.length > 0) {
    var task = precomputeQueue.shift();
    precomputeActive++;
    task().finally(function () {
      precomputeActive--;
      processPrecomputeQueue();
      // Clear keepalive alarm when queue is drained
      if (precomputeActive === 0 && precomputeQueue.length === 0) {
        precomputeRunning = false;
        chrome.alarms.clear("precompute-keepalive");
        console.log("[SN AI Plugin] Precompute complete, keepalive cleared");
      }
    });
  }
}

function enqueuePrecompute(fn) {
  precomputeQueue.push(fn);
  processPrecomputeQueue();
}

// --- ServiceNow REST API ---

function fetchIncidents(origin, gck, assignmentGroup) {
  var query = "assignment_group.nameLIKE" + assignmentGroup +
              "^stateNOT IN6,7";
  var fields = "sys_id,short_description,description";
  var url = origin + "/api/now/table/incident" +
            "?sysparm_query=" + encodeURIComponent(query) +
            "&sysparm_fields=" + encodeURIComponent(fields) +
            "&sysparm_display_value=true" +
            "&sysparm_limit=50";

  return fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-UserToken": gck,
    },
    credentials: "include",
  })
  .then(function (r) {
    if (!r.ok) throw new Error("SN API error: " + r.status);
    return r.json();
  })
  .then(function (data) {
    return data.result || [];
  });
}

function fetchJournalEntries(origin, gck, sysId) {
  var url = origin + "/api/now/table/sys_journal_field" +
            "?sysparm_query=element_id=" + sysId +
            "^elementINcomments,work_notes" +
            "&sysparm_fields=value,element,sys_created_on,sys_created_by" +
            "&sysparm_display_value=true" +
            "&sysparm_limit=20" +
            "&sysparm_orderby=sys_created_on";

  return fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-UserToken": gck,
    },
    credentials: "include",
  })
  .then(function (r) {
    if (!r.ok) throw new Error("SN journal API error: " + r.status);
    return r.json();
  })
  .then(function (data) {
    return data.result || [];
  });
}

// Parse un champ journal SN (display_value) en entrees individuelles.
// Format d'une entree : "YYYY-MM-DD HH:MM:SS - Auteur (Label)\n<contenu>"
// Les entrees sont du plus recent au plus ancien.
function parseJournalField(text, sender) {
  if (!text) return [];
  var headerRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - .*?\(.*?\)\s*$/gm;
  var heads = [];
  var m;
  while ((m = headerRe.exec(text)) !== null) {
    heads.push({ ts: m[1], start: m.index, contentStart: headerRe.lastIndex });
  }
  var out = [];
  for (var i = 0; i < heads.length; i++) {
    var end = (i + 1 < heads.length) ? heads[i + 1].start : text.length;
    var content = text.slice(heads[i].contentStart, end).trim();
    if (content) out.push({ ts: heads[i].ts, sender: sender, content: content });
  }
  return out;
}

// Recupere l'historique du ticket via les champs comments/work_notes du record
// incident (display_value) — l'API table/sys_journal_field est bloquee par ACL.
// Retourne les messages en ordre CHRONOLOGIQUE (le plus recent en dernier).
function fetchTicketComments(origin, gck, sysId) {
  var url = origin + "/api/now/table/incident/" + sysId +
            "?sysparm_fields=comments,work_notes&sysparm_display_value=true";
  return fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json", "X-UserToken": gck },
    credentials: "include",
  })
  .then(function (r) {
    if (!r.ok) throw new Error("SN incident API error: " + r.status);
    return r.json();
  })
  .then(function (data) {
    var rec = data.result || {};
    var msgs = parseJournalField(rec.comments, "client")
      .concat(parseJournalField(rec.work_notes, "agent_support"));
    msgs.sort(function (a, b) { return a.ts < b.ts ? -1 : (a.ts > b.ts ? 1 : 0); });
    return msgs.map(function (e) { return { sender: e.sender, content: e.content }; });
  });
}

// --- Streaming SSE (affichage token par token, chemin à la demande) ---
// Distinct du précompute (qui reste non-streaming et alimente le cache).

// Enrichit les sources brutes du backend (event SSE "sources") pour matcher la
// forme attendue par la proposition box (number, cited, champs modal).
function enrichStreamSources(sources) {
  var list = Array.isArray(sources) ? sources : [];
  return list.map(function (src, i) {
    var num = i + 1;
    return {
      number: num,
      title: (src.title || "Source " + num).replace(/\.md$/, ""),
      source_url: src.source_url || "",
      score: typeof src.score === "number" ? src.score : null,
      snippet: src.snippet || "",
      precise_content: src.precise_content || src.snippet || "",
      context_content: src.context_content || src.precise_content || src.snippet || "",
      header_path: src.header_path || "",
      page_number: typeof src.page_number === "number" ? src.page_number : null,
      file_type: src.file_type || "",
      search_text_start: src.search_text_start || "",
      search_text_end: src.search_text_end || "",
      cited: true,
    };
  });
}

// Lit le flux SSE et relaie chunks/sources au port. Événements backend :
// {type:"metadata"} {type:"sources",sources} {type:"answer_chunk",content} {type:"done"}
function readSSEStream(body, port) {
  var reader = body.getReader();
  var decoder = new TextDecoder();
  var buffer = "";
  function pump() {
    return reader.read().then(function (result) {
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split("\n");
      buffer = lines.pop(); // garde la dernière ligne potentiellement incomplète
      lines.forEach(function (line) {
        line = line.trim();
        if (!line || line.indexOf("data:") !== 0) return;
        var data = line.substring(5).trim();
        if (!data) return;
        try {
          var ev = JSON.parse(data);
          if (ev.type === "answer_chunk" && ev.content) {
            port.postMessage({ type: "chunk", text: ev.content });
          } else if (ev.type === "sources") {
            port.postMessage({ type: "sources", sources: enrichStreamSources(ev.sources) });
          }
          // metadata ignoré ; done géré par le finally côté handler
        } catch (e) { /* keepalive / ligne non-JSON : ignorer */ }
      });
      return pump();
    });
  }
  return pump();
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== "rag-stream") return;

  port.onMessage.addListener(function (request) {
    if (request.type !== "rag-generate") return;

    var payload = request.payload || {};
    payload.stream = true;
    var sysId = request.sysId;

    chrome.storage.local.get({ apiKey: API_KEY_DEFAULT, snGck: "", snOrigin: "" }, function (settings) {
      // Historique via l'API record (comme le non-stream), remplace previous_messages.
      var prep = Promise.resolve();
      if (sysId && settings.snGck && settings.snOrigin) {
        prep = fetchTicketComments(settings.snOrigin, settings.snGck, sysId)
          .then(function (messages) { payload.previous_messages = messages; })
          .catch(function (e) { console.warn("[SN AI Plugin] stream: lecture comments échouée:", e); });
      }

      prep.then(function () {
        buildRagHeaders(settings.apiKey).then(function (headers) {
          if (!headers["Authorization"] && !settings.apiKey) {
            port.postMessage({ type: "error", error: "Non connecté : ouvre le popup et connecte-toi (OIDC)." });
            port.postMessage({ type: "done" });
            return;
          }
          var controller = new AbortController();
          var timeoutId = setTimeout(function () { controller.abort(); }, 120000);

          fetch(API_URL, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          })
          .then(function (response) {
            if (!response.ok) {
              return response.text().then(function (b) {
                throw new Error("API error: " + response.status + " - " + b.substring(0, 200));
              });
            }
            return readSSEStream(response.body, port);
          })
          .catch(function (err) {
            port.postMessage({ type: "error", error: err.message });
          })
          .finally(function () {
            clearTimeout(timeoutId);
            port.postMessage({ type: "done" });
          });
        });
      });
    });
  });
});

// --- Precompute orchestration ---

var precomputeRunning = false;

function handlePrecomputeInit(request) {
  if (precomputeRunning) {
    console.warn("[SN AI Plugin] Precompute already running, ignoring duplicate call");
    return;
  }
  precomputeRunning = true;

  var gck = request.gck;
  var origin = request.origin;
  var assignmentGroup = request.assignmentGroup;

  chrome.storage.local.get(
    { precomputeCache: {}, apiKey: "", rerank: true, model: "moonshotai/Kimi-K2.6", topK: 10, indexKey: "" },
    function (settings) {
      // Plus de gate API key : l'auth passe par le Bearer OIDC (buildRagHeaders).
      // Si l'utilisateur n'est pas connecté, les appels RAG renverront 401.

      fetchIncidents(origin, gck, assignmentGroup)
        .then(function (incidents) {
          console.log("[SN AI Plugin] ====== TICKETS FOUND: " + incidents.length + " ======");
          incidents.forEach(function (inc, i) {
            console.log("[SN AI Plugin]   " + (i + 1) + ". " + inc.sys_id + " | " + (inc.short_description || "(no title)"));
          });

          var cache = settings.precomputeCache;

          console.log("[SN AI Plugin] ====== QUEUING " + incidents.length + " tickets for hash check ======");

          // Start keepalive alarm
          chrome.alarms.create("precompute-keepalive", { periodInMinutes: 0.4 });

          var totalQueued = incidents.length;
          var skippedCount = 0;
          var processedCount = 0;

          incidents.forEach(function (incident, idx) {
            enqueuePrecompute(function () {
              // Fetch journal entries first so we can compute the full hash
              return fetchTicketComments(origin, gck, incident.sys_id)
                .then(function (previousMessages) {
                  var fullContent = (incident.short_description || "") + "|" +
                                    (incident.description || "") + "|" +
                                    previousMessages.map(function (m) { return m.content; }).join("|");
                  var hash = simpleHash(fullContent);

                  var cached = cache[incident.sys_id];
                  if (cached && cached.hash === hash && cached.schemaVersion === CACHE_SCHEMA_VERSION) {
                    skippedCount++;
                    console.log("[SN AI Plugin] SKIP (cached) " + (idx + 1) + "/" + totalQueued + " | " + incident.short_description);
                    return;
                  }

                  processedCount++;
                  console.log("[SN AI Plugin] >>> RAG START " + (idx + 1) + "/" + totalQueued + " | " + incident.short_description);
                  return precomputeForTicketWithMessages(incident, hash, previousMessages, settings);
                })
                .then(function () {
                  console.log("[SN AI Plugin] <<< DONE " + (idx + 1) + "/" + totalQueued + " | " + incident.short_description);
                });
            });
          });
        })
        .catch(function (err) {
          console.error("[SN AI Plugin] Precompute fetch error:", err);
          precomputeRunning = false;
        });
    }
  );
}

function precomputeForTicketWithMessages(incident, hash, previousMessages, settings) {
  console.log("[SN AI Plugin] Precomputing for", incident.sys_id, "(", incident.short_description, ")");

  var payload = {
    description: incident.description || "",
    short_description: incident.short_description || "Ticket ServiceNow",
    previous_messages: previousMessages,
    library: API_LIBRARY,
    model: settings.model,
    top_k: settings.topK,
    temperature: 0.3,
    rerank: settings.rerank,
  };

  return buildRagHeaders(settings.apiKey).then(function (headers) {
    return fetch(API_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    });
  })
    .then(function (response) {
      if (!response.ok) throw new Error("RAG API error: " + response.status);
      return response.json();
    })
    .then(function (data) {
      var answer = data.answer || data.response || data.message ||
                   data.text || data.content ||
                   (typeof data === "string" ? data : JSON.stringify(data));
      var built = buildResponsePayload(answer, data.sources);

      return new Promise(function (resolve) {
        chrome.storage.local.get({ precomputeCache: {} }, function (stored) {
          var cache = stored.precomputeCache;
          cache[incident.sys_id] = {
            hash: hash,
            response: built.text,
            sources: built.sources,
            schemaVersion: CACHE_SCHEMA_VERSION,
            timestamp: Date.now(),
            shortDescription: incident.short_description,
          };
          chrome.storage.local.set({ precomputeCache: cache }, function () {
            console.log("[SN AI Plugin] Cached response for", incident.sys_id, "(" + built.sources.length + " sources)");
            resolve();
          });
        });
      });
    })
    .catch(function (err) {
      console.error("[SN AI Plugin] Precompute failed for", incident.sys_id, ":", err);
    });
}

// --- Cache eviction (remove entries older than 7 days) ---

function evictOldCacheEntries() {
  chrome.storage.local.get({ precomputeCache: {} }, function (data) {
    var cache = data.precomputeCache;
    var now = Date.now();
    var maxAge = 7 * 24 * 60 * 60 * 1000;
    var changed = false;

    Object.keys(cache).forEach(function (sysId) {
      if (now - cache[sysId].timestamp > maxAge) {
        delete cache[sysId];
        changed = true;
      }
    });

    if (changed) {
      chrome.storage.local.set({ precomputeCache: cache });
      console.log("[SN AI Plugin] Evicted old cache entries");
    }
  });
}

evictOldCacheEntries();

// --- Periodic precompute (runs from background without user on SN page) ---

var PRECOMPUTE_INTERVAL_MINUTES = 15;
var GCK_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours — assume session expired after this

chrome.alarms.create("precompute-periodic", { periodInMinutes: PRECOMPUTE_INTERVAL_MINUTES });
console.log("[SN AI Plugin] Periodic precompute alarm set every " + PRECOMPUTE_INTERVAL_MINUTES + " min");

function handlePeriodicPrecompute() {
  if (precomputeRunning) {
    console.log("[SN AI Plugin] Periodic: precompute already running, skipping");
    return;
  }

  chrome.storage.local.get(
    { snGck: "", snOrigin: "", snGckTimestamp: 0, assignmentGroup: "", apiKey: "" },
    function (data) {
      if (!data.snGck || !data.snOrigin) {
        console.log("[SN AI Plugin] Periodic: no stored g_ck/origin, skipping (visit a SN page first)");
        return;
      }
      if (!data.assignmentGroup) {
        console.log("[SN AI Plugin] Periodic: no assignment group configured, skipping");
        return;
      }
      if (Date.now() - data.snGckTimestamp > GCK_MAX_AGE_MS) {
        console.log("[SN AI Plugin] Periodic: g_ck too old (" +
          Math.round((Date.now() - data.snGckTimestamp) / 3600000) + "h), skipping");
        return;
      }

      console.log("[SN AI Plugin] Periodic precompute triggered for group:", data.assignmentGroup);
      handlePrecomputeInit({
        gck: data.snGck,
        origin: data.snOrigin,
        assignmentGroup: data.assignmentGroup,
      });
    }
  );
}

// --- Alarm handler ---

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === "precompute-keepalive") {
    console.log("[SN AI Plugin] Keepalive: active=" + precomputeActive + " queued=" + precomputeQueue.length);
  }
  if (alarm.name === "precompute-periodic") {
    handlePeriodicPrecompute();
  }
});

// --- Navigation-triggered precompute (debounced) ---

var PRECOMPUTE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes minimum between triggers
var lastPrecomputeTrigger = 0;

function handlePageLoaded() {
  var now = Date.now();
  if (now - lastPrecomputeTrigger < PRECOMPUTE_COOLDOWN_MS) {
    console.log("[SN AI Plugin] Navigation trigger debounced (" +
      Math.round((now - lastPrecomputeTrigger) / 1000) + "s since last)");
    return;
  }
  lastPrecomputeTrigger = now;
  console.log("[SN AI Plugin] Navigation detected, triggering precompute check");
  handlePeriodicPrecompute();
}

// --- Message handler ---

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.type === "sn-page-loaded") {
    handlePageLoaded();
    sendResponse({ ok: true });
    return false;
  }

  if (request.type === "precompute-init") {
    lastPrecomputeTrigger = Date.now(); // reset cooldown on manual trigger too
    handlePrecomputeInit(request);
    sendResponse({ ok: true });
    return false;
  }

  if (request.type !== "rag-generate") return false;

  var payload = request.payload;

  chrome.storage.local.get({ apiKey: API_KEY_DEFAULT, snGck: "", snOrigin: "" }, function (settings) {

    // L'historique de conversation est recupere via l'API ServiceNow (fiable,
    // independant de l'UI classique/moderne) plutot que par scraping DOM cote
    // content script. Sans ca, les questions de suivi ne remontent pas et le RAG
    // re-repond a la question initiale du ticket.
    var prep = Promise.resolve();
    if (request.sysId && settings.snGck && settings.snOrigin) {
      prep = fetchTicketComments(settings.snOrigin, settings.snGck, request.sysId)
        .then(function (messages) {
          payload.previous_messages = messages;
          console.log("[SN AI Plugin] on-demand: " + messages.length + " messages depuis comments/work_notes");
        })
        .catch(function (e) {
          console.warn("[SN AI Plugin] lecture comments echouee, fallback messages DOM:", e);
        });
    }

    prep.then(function () {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, 120000);

      buildRagHeaders(settings.apiKey).then(function (headers) {
        // L'auth passe par le Bearer OIDC. La clé API n'est plus requise.
        if (!headers["Authorization"] && !settings.apiKey) {
          throw new Error("Non connecté : ouvre le popup et connecte-toi (OIDC), ou configure une clé API.");
        }
        return fetch(API_URL, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      })
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (body) {
            console.error("[SN AI Plugin] API error " + response.status + ":", body);
            throw new Error("API error: " + response.status + " - " + body.substring(0, 200));
          });
        }
        return response.json();
      })
      .then(function (data) {
        var answer =
          data.answer ||
          data.response ||
          data.message ||
          data.text ||
          data.content ||
          (typeof data === "string" ? data : JSON.stringify(data));

        var built = buildResponsePayload(answer, data.sources);
        sendResponse({ success: true, text: built.text, sources: built.sources });
      })
      .catch(function (err) {
        sendResponse({ success: false, error: err.message });
      })
      .finally(function () {
        clearTimeout(timeoutId);
      });
    });
  });

  return true;
});
