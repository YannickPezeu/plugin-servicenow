// inject.js — Runs in the MAIN world (page context) to access AngularJS scope
// Injected by content.js via <script> tag

(function () {
  "use strict";

  document.addEventListener("servicenow-ai-fill", function (e) {
    var detail = e.detail || {};
    var textareaId = detail.textareaId;
    var message = detail.message;
    var scopeField = detail.scopeField; // e.g. "activity_field_0.value"

    if (!textareaId || !message) return;

    var textarea = document.getElementById(textareaId);
    if (!textarea) {
      console.warn("[SN AI Plugin] Textarea not found:", textareaId);
      return;
    }

    // Try AngularJS scope approach first
    var success = false;
    if (typeof angular !== "undefined") {
      try {
        var scope = angular.element(textarea).scope();
        if (scope) {
          scope.$apply(function () {
            // Navigate the scope field path (e.g. "activity_field_0.value")
            var parts = scopeField.split(".");
            var target = scope;
            for (var i = 0; i < parts.length - 1; i++) {
              target = target[parts[i]];
            }
            target[parts[parts.length - 1]] = message;
          });
          success = true;
          console.log("[SN AI Plugin] Value set via Angular scope for", textareaId);
        }
      } catch (err) {
        console.warn("[SN AI Plugin] Angular scope approach failed:", err);
      }
    }

    // Fallback: set value directly + dispatch events
    textarea.value = message;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.dispatchEvent(new Event("blur", { bubbles: true }));

    if (!success) {
      console.log("[SN AI Plugin] Value set via fallback (DOM events) for", textareaId);
    }

    // Signal back to content script that injection is done
    document.dispatchEvent(
      new CustomEvent("servicenow-ai-fill-done", {
        detail: { textareaId: textareaId, success: true },
      })
    );
  });

  // Send g_ck CSRF token to content script via DOM attribute (cross-world safe)
  var gck = window.g_ck;
  if (gck) {
    document.documentElement.setAttribute("data-sn-ai-gck", gck);
    document.dispatchEvent(new CustomEvent("sn-ai-gck"));
  }
})();
