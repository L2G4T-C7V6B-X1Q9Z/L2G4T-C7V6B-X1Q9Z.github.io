(function() {
  'use strict';
  var HASH = '35efb6af090ef6353390fe596e9d043af862e6b9269084a74564835a57ddc2ea';
  var KEY = 'site_auth';

  if (sessionStorage.getItem(KEY) === HASH) return;

  // Hide page content immediately
  document.documentElement.style.visibility = 'hidden';
  document.documentElement.style.background = '#ffffff';

  async function sha256(str) {
    var buf = new TextEncoder().encode(str);
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(function(b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  function init() {
    // Create overlay
    var overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    var box = document.createElement('div');
    box.style.cssText = 'text-align:center;max-width:320px;width:90%;';

    var title = document.createElement('div');
    title.textContent = 'Password Required';
    title.style.cssText = 'font-size:1.25rem;font-weight:600;color:#3a3a3a;margin-bottom:1.5rem;letter-spacing:-0.02em;';

    var input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Enter password';
    input.autocomplete = 'off';
    input.style.cssText = 'width:100%;padding:0.7rem 1rem;font-size:1rem;border:1px solid #e0e0e0;border-radius:8px;outline:none;font-family:inherit;transition:border-color 0.2s;';
    input.addEventListener('focus', function() { input.style.borderColor = '#c0392b'; });
    input.addEventListener('blur', function() { input.style.borderColor = '#e0e0e0'; });

    var err = document.createElement('div');
    err.style.cssText = 'font-size:0.85rem;color:#c0392b;margin-top:0.75rem;min-height:1.2em;';

    box.appendChild(title);
    box.appendChild(input);
    box.appendChild(err);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Show page structure but keep overlay on top
    document.documentElement.style.visibility = 'visible';

    input.focus();

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        sha256(input.value).then(function(h) {
          if (h === HASH) {
            sessionStorage.setItem(KEY, HASH);
            overlay.remove();
          } else {
            err.textContent = 'Incorrect password';
            input.value = '';
            input.focus();
          }
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
