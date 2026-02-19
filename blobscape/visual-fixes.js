// ══════════════════════════════════════════
// Blobscape Visual Fixes
// Non-destructive enhancements loaded after index.html
// ══════════════════════════════════════════

const VisualFixes = (function () {
  'use strict';

  // ── Palette classification ──
  // Dark palettes are those with the `dark: true` flag (Void, Night Vision).
  // "Warm light" palettes have bright veils (Sunset, Ember, Golden Hour, etc.).
  // We detect this at runtime by inspecting the global PALETTES array.

  function isDarkPalette(idx) {
    return !!(typeof PALETTES !== 'undefined' && PALETTES[idx] && PALETTES[idx].dark);
  }

  function getPaletteName(idx) {
    if (typeof PALETTES !== 'undefined' && PALETTES[idx]) return PALETTES[idx].name;
    return '';
  }

  // ── Injectable CSS ──
  const CSS_FIXES = `
    /* ── Hint bar: more visible when controls shown ── */
    body.active #hint {
      opacity: 1 !important;
      color: rgba(255, 255, 255, 0.50);
    }

    /* ── Palette dot tooltip animation ── */
    .palette-label {
      transform: translateX(-50%) translateY(4px);
      transition: opacity 0.25s ease, transform 0.25s ease;
    }

    .palette-dot:hover .palette-label {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* ── Palette dot: subtle pulse on hover ── */
    .palette-dot {
      transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1),
                  border-color 0.3s ease,
                  box-shadow 0.3s ease;
    }

    .palette-dot:hover {
      box-shadow: 0 0 12px rgba(255, 255, 255, 0.12);
    }

    .palette-dot.selected {
      box-shadow: 0 0 14px rgba(255, 255, 255, 0.22);
    }

    /* ── Veil: eliminate sub-pixel gaps by matching scene inset ── */
    #veil {
      inset: -250px;
      transition: background-color 1.6s ease,
                  backdrop-filter 1.6s ease,
                  -webkit-backdrop-filter 1.6s ease;
    }

    /* ── Scene: ensure no rendering seams ── */
    #scene {
      backface-visibility: hidden;
    }

    /* ── Smooth body background transitions ── */
    body {
      transition: background-color 1.6s ease;
    }

    /* ── Dark palette overrides (applied dynamically via class) ── */
    body.vf-dark #veil {
      backdrop-filter: blur(8px) saturate(1.0) !important;
      -webkit-backdrop-filter: blur(8px) saturate(1.0) !important;
      background-color: transparent !important;
    }

    body.vf-dark-void #veil {
      backdrop-filter: blur(6px) saturate(1.0) !important;
      -webkit-backdrop-filter: blur(6px) saturate(1.0) !important;
      background-color: rgba(0, 0, 0, 0.02) !important;
    }

    body.vf-dark-nightvision #veil {
      backdrop-filter: blur(10px) saturate(1.0) !important;
      -webkit-backdrop-filter: blur(10px) saturate(1.0) !important;
      background-color: rgba(20, 0, 0, 0.04) !important;
    }
  `;

  // ── Inject styles ──
  function injectCSS() {
    const style = document.createElement('style');
    style.id = 'vf-styles';
    style.textContent = CSS_FIXES;
    document.head.appendChild(style);
  }

  // ── Vignette removed ──
  function createVignette() { /* disabled */ }

  // ── Text visibility fixes ──
  // We monkey-patch switchPalette to apply our opacity/shadow overrides
  // after the original function runs.

  let _origSwitchPalette = null;

  function applyTextFixes(idx) {
    const dark = isDarkPalette(idx);
    const name = getPaletteName(idx);
    const clockEl = document.getElementById('clock');
    const solarEl = document.getElementById('solar-info');

    if (clockEl) {
      clockEl.style.opacity = dark ? '0.75' : '0.70';
      clockEl.style.textShadow = 'none';
    }

    if (solarEl) {
      if (!solarEl.classList.contains('loading')) {
        solarEl.style.opacity = dark ? '0.65' : '0.60';
      }
      solarEl.style.textShadow = 'none';
    }

    // Also fix weather widget
    const weatherEl = document.getElementById('celestial-weather');
    if (weatherEl) {
      weatherEl.style.textShadow = 'none';
      weatherEl.style.opacity = dark ? '0.65' : '0.60';
    }
  }

  // ── Dark palette body class management ──
  function applyDarkClasses(idx) {
    const body = document.body;
    const name = getPaletteName(idx);
    const dark = isDarkPalette(idx);

    // Remove all vf-dark classes
    body.classList.remove('vf-dark', 'vf-dark-void', 'vf-dark-nightvision');

    if (dark) {
      body.classList.add('vf-dark');
      if (name === 'Void') {
        body.classList.add('vf-dark-void');
      } else if (name === 'Night Vision') {
        body.classList.add('vf-dark-nightvision');
      }
    }
  }

  // ── Dark palette blob tuning ──
  // Void: ethereal white wisps, very low opacity
  // Night Vision: dim red, submarine control room feel
  function applyDarkBlobTuning(idx) {
    const name = getPaletteName(idx);

    if (name === 'Void') {
      // Override Void blobs to be barely visible white wisps
      if (typeof blobs !== 'undefined' && typeof PALETTES !== 'undefined') {
        const pal = PALETTES[idx];
        blobs.forEach((b, i) => {
          const ci = i % pal.colors.length;
          // White wisps: very low lightness range, near-zero saturation
          const l = 18 + (ci * 4); // range 18-34, subtle variation
          const a1 = 0.22;
          const a2 = 0.10;
          const grad = `radial-gradient(circle at 50% 50%,
            hsla(0, 0%, ${l}%, ${a1}),
            hsla(0, 0%, ${l}%, ${a2}) 45%,
            transparent 72%)`;
          b.el.style.background = grad;
          b.el.style.opacity = '0.40';
        });
      }
    } else if (name === 'Night Vision') {
      // Override Night Vision blobs: very dim red glow
      if (typeof blobs !== 'undefined' && typeof PALETTES !== 'undefined') {
        const pal = PALETTES[idx];
        blobs.forEach((b, i) => {
          const ci = i % pal.colors.length;
          const c = pal.colors[ci];
          // Reduce lightness and opacity for dim submarine feel
          const dimL = Math.max(c.l - 6, 12);
          const a1 = 0.30;
          const a2 = 0.14;
          const grad = `radial-gradient(circle at 50% 50%,
            hsla(${c.h}, ${c.s}%, ${dimL}%, ${a1}),
            hsla(${c.h}, ${c.s}%, ${dimL}%, ${a2}) 45%,
            transparent 72%)`;
          b.el.style.background = grad;
          b.el.style.opacity = '0.45';
        });
      }
    }
  }

  // ── Master palette fix dispatcher ──
  function applyPaletteFixes(idx) {
    applyTextFixes(idx);
    applyDarkClasses(idx);
    applyDarkBlobTuning(idx);
  }

  // ── Hook into switchPalette ──
  function hookSwitchPalette() {
    if (typeof window.switchPalette !== 'function') {
      // switchPalette might be in local scope. We need to intercept it.
      // Since it's defined at top-level in a script tag, it should be on window
      // in non-strict mode. If not, we use a MutationObserver fallback.
      return false;
    }

    _origSwitchPalette = window.switchPalette;

    window.switchPalette = function (idx) {
      _origSwitchPalette(idx);
      // Apply our fixes after the original has run
      // Use the normalized index from currentPalette (set by the original)
      applyPaletteFixes(typeof currentPalette !== 'undefined' ? currentPalette : idx);
    };

    return true;
  }

  // ── Fallback: observe DOM changes to detect palette switches ──
  // If switchPalette isn't globally accessible, we watch for body background changes.
  function setupFallbackObserver() {
    let lastBg = '';
    const observer = new MutationObserver(() => {
      const bg = document.body.style.backgroundColor || document.body.style.background;
      if (bg !== lastBg) {
        lastBg = bg;
        // Determine current palette index by matching background
        if (typeof PALETTES !== 'undefined' && typeof currentPalette !== 'undefined') {
          applyPaletteFixes(currentPalette);
        }
      }
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['style'],
    });
  }

  // ── Smooth palette transitions: ensure no flicker ──
  // Pre-set transition on blob elements so color changes are always smooth
  function ensureSmoothTransitions() {
    if (typeof blobs === 'undefined') return;
    blobs.forEach((b) => {
      if (b.el) {
        // Set a persistent base transition that won't be cleared
        // The original code sets and then clears transitions; we add a
        // CSS custom property approach instead via the injected styles
        b.el.style.willChange = 'transform, background, opacity, border-radius';
      }
    });
  }

  // ── Initialization ──
  function init() {
    // 1. Inject CSS fixes
    injectCSS();

    // 2. Create vignette overlay
    createVignette();

    // 3. Hook switchPalette or set up fallback
    const hooked = hookSwitchPalette();
    if (!hooked) {
      setupFallbackObserver();
    }

    // 4. Smooth transitions on blobs
    ensureSmoothTransitions();

    // 5. Apply fixes to current palette immediately
    const idx = typeof currentPalette !== 'undefined' ? currentPalette : 0;
    applyPaletteFixes(idx);

    // 6. Also re-apply after a brief delay to catch any initialization races
    setTimeout(() => {
      const idx2 = typeof currentPalette !== 'undefined' ? currentPalette : 0;
      applyPaletteFixes(idx2);
    }, 200);
  }

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already loaded (script loaded at end of body or deferred)
    init();
  }

  // ── Public API ──
  return {
    init,
    applyPaletteFixes,
    isDarkPalette,
    getPaletteName,
  };
})();
