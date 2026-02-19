/**
 * Blobscape UI Components
 * Settings drawer, analog clock, word clock, date display, and more.
 * Loaded as a script tag after the main index.html script block.
 */
const UIComponents = (function () {

  // ══════════════════════════════════════════
  // CSS
  // ══════════════════════════════════════════

  const CSS = `
    /* ── Settings gear button ── */
    #settings-btn {
      top: 56px;
      right: 14px;
    }
    #settings-btn svg {
      transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }
    #settings-btn:hover svg {
      transform: rotate(45deg);
    }

    /* ── Settings drawer ── */
    #settings-drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: 310px;
      height: 100%;
      z-index: 100;
      transform: translateX(100%);
      transition: transform 0.38s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      pointer-events: none;
    }
    #settings-drawer.open {
      transform: translateX(0);
      pointer-events: auto;
    }

    #settings-drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.25);
      z-index: 99;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.38s ease;
    }
    #settings-drawer-backdrop.visible {
      opacity: 1;
      pointer-events: auto;
    }

    #settings-drawer-inner {
      flex: 1;
      background: rgba(18, 18, 22, 0.82);
      backdrop-filter: blur(32px) saturate(1.2);
      -webkit-backdrop-filter: blur(32px) saturate(1.2);
      border-left: 1px solid rgba(255, 255, 255, 0.06);
      overflow-y: auto;
      overflow-x: hidden;
      padding: 28px 22px 36px;
    }
    #settings-drawer-inner::-webkit-scrollbar {
      width: 4px;
    }
    #settings-drawer-inner::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
    }

    /* ── Drawer heading ── */
    .sd-title {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.35);
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    /* ── Section label ── */
    .sd-label {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.04em;
      color: rgba(255, 255, 255, 0.5);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .sd-label-value {
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, 0.3);
      font-weight: 400;
    }

    /* ── Slider ── */
    .sd-slider-wrap {
      margin-bottom: 22px;
    }
    .sd-slider {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 3px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.08);
      outline: none;
      cursor: pointer;
      transition: background 0.2s ease;
    }
    .sd-slider:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .sd-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.7);
      border: none;
      cursor: pointer;
      transition: transform 0.15s ease, background 0.15s ease;
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.3);
    }
    .sd-slider::-webkit-slider-thumb:hover {
      transform: scale(1.2);
      background: rgba(255, 255, 255, 0.9);
    }
    .sd-slider::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.7);
      border: none;
      cursor: pointer;
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.3);
    }

    /* ── Button group ── */
    .sd-btn-group {
      display: flex;
      gap: 4px;
      margin-bottom: 22px;
      flex-wrap: wrap;
    }
    .sd-btn {
      flex: 1;
      min-width: 0;
      padding: 7px 6px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.03);
      color: rgba(255, 255, 255, 0.4);
      font-family: 'Inter', sans-serif;
      font-size: 10.5px;
      font-weight: 500;
      letter-spacing: 0.02em;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sd-btn:hover {
      background: rgba(255, 255, 255, 0.07);
      color: rgba(255, 255, 255, 0.6);
      border-color: rgba(255, 255, 255, 0.14);
    }
    .sd-btn.active {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.85);
      border-color: rgba(255, 255, 255, 0.2);
    }

    /* Clock style group: 2 rows of 3 */
    #clock-style-group .sd-btn {
      flex: 0 0 calc(33.3% - 3px);
    }

    /* Font-specific button previews */
    .sd-btn[data-font="sans"]   { font-family: 'Inter', sans-serif; }
    .sd-btn[data-font="mono"]   { font-family: 'SF Mono', 'Consolas', 'Menlo', monospace; font-size: 10px; }
    .sd-btn[data-font="serif"]  { font-family: Georgia, 'Times New Roman', serif; }
    .sd-btn[data-font="pixel"]  { font-family: 'Courier New', monospace; letter-spacing: 0.08em; font-size: 10px; }

    /* ── Toggle ── */
    .sd-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding: 0 2px;
    }
    .sd-toggle-text {
      font-size: 12px;
      font-weight: 400;
      color: rgba(255, 255, 255, 0.5);
      letter-spacing: 0.01em;
    }
    .sd-toggle {
      position: relative;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
      cursor: pointer;
    }
    .sd-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }
    .sd-toggle-track {
      position: absolute;
      inset: 0;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      transition: background 0.25s ease;
    }
    .sd-toggle input:checked + .sd-toggle-track {
      background: rgba(255, 255, 255, 0.22);
    }
    .sd-toggle-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.45);
      transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), background 0.25s ease;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    }
    .sd-toggle input:checked ~ .sd-toggle-knob {
      transform: translateX(16px);
      background: rgba(255, 255, 255, 0.85);
    }

    /* ── Divider ── */
    .sd-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.05);
      margin: 20px 0;
    }

    /* ── Analog clock SVG ── */
    #analog-clock {
      position: fixed;
      bottom: 50%;
      left: 50%;
      transform: translate(-50%, 50%);
      z-index: 5;
      pointer-events: none;
      opacity: 0.70;
      transition: opacity 1.2s ease;
    }

    /* ── Word clock ── */
    #word-clock {
      position: fixed;
      bottom: 50%;
      left: 50%;
      transform: translate(-50%, 50%);
      z-index: 5;
      pointer-events: none;
      opacity: 0.70;
      font-family: Georgia, 'Times New Roman', serif;
      font-size: clamp(2rem, 5.5vw, 4.5rem);
      font-weight: 400;
      font-style: italic;
      letter-spacing: 0.02em;
      text-align: center;
      white-space: nowrap;
      transition: color 1.2s ease, opacity 1.2s ease;
    }

    /* ── Binary clock ── */
    #binary-clock {
      position: fixed;
      bottom: 50%;
      left: 50%;
      transform: translate(-50%, 50%);
      z-index: 5;
      pointer-events: none;
      opacity: 0.70;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
      font-size: clamp(2.2rem, 5vw, 4rem);
      font-weight: 300;
      letter-spacing: 0.08em;
      text-align: center;
      white-space: nowrap;
      transition: color 1.2s ease, opacity 1.2s ease;
    }

    /* ── Hex clock ── */
    #hex-clock {
      position: fixed;
      bottom: 50%;
      left: 50%;
      transform: translate(-50%, 50%);
      z-index: 5;
      pointer-events: none;
      opacity: 0.70;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
      font-size: clamp(3rem, 8vw, 7rem);
      font-weight: 300;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      text-align: center;
      white-space: nowrap;
      transition: color 1.2s ease, opacity 1.2s ease;
      font-variant-numeric: tabular-nums;
    }

    /* ── Date display ── */
    #date-display {
      position: fixed;
      bottom: calc(50% - clamp(2.8rem, 6.5vw, 5.8rem));
      left: 50%;
      transform: translateX(-50%);
      z-index: 5;
      pointer-events: none;
      font-size: clamp(0.85rem, 1.8vw, 1.25rem);
      font-weight: 300;
      letter-spacing: 0.06em;
      text-align: center;
      white-space: nowrap;
      transition: color 1.2s ease, opacity 1.2s ease;
      opacity: 0.40;
    }

    /* ── Clock font families (all clock elements) ── */
    #clock.font-sans, #word-clock.font-sans, #binary-clock.font-sans, #hex-clock.font-sans
      { font-family: 'Inter', -apple-system, 'Segoe UI', sans-serif; }
    #clock.font-mono, #word-clock.font-mono, #binary-clock.font-mono, #hex-clock.font-mono
      { font-family: 'SF Mono', 'Consolas', 'Menlo', monospace; }
    #clock.font-serif, #word-clock.font-serif, #binary-clock.font-serif, #hex-clock.font-serif
      { font-family: Georgia, 'Times New Roman', serif; font-weight: 400; }
    #clock.font-pixel, #word-clock.font-pixel, #binary-clock.font-pixel, #hex-clock.font-pixel
      { font-family: 'Courier New', monospace; letter-spacing: 0.12em; }

    /* ── Hint update (add S shortcut) ── */
    #hint-ext {
      position: fixed;
      bottom: 72px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 11px;
      color: rgba(255,255,255,0.28);
      z-index: 20;
      opacity: 0;
      transition: opacity 0.4s ease;
      pointer-events: none;
      white-space: nowrap;
    }
    body.active #hint-ext { opacity: 1; }
  `;

  // ══════════════════════════════════════════
  // SETTINGS STATE
  // ══════════════════════════════════════════

  const DEFAULTS = {
    blobSpeed: 1.0,
    contrast: 1.0,
    clockStyle: 'digital',  // digital, analog, word, binary, hex, hidden
    clockFont: 'sans',      // sans, mono, serif, pixel
    showDate: true,
    showSolarArc: false,
    showWeather: true,
  };

  let settings = { ...DEFAULTS };
  let drawerOpen = false;
  let drawerAutoCloseTimer = null;
  let analogAnimFrame = null;

  // ══════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════

  function loadSettings() {
    try {
      const saved = localStorage.getItem('blobscape-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        settings = { ...DEFAULTS, ...parsed };
      }
    } catch (e) { /* ignore */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem('blobscape-settings', JSON.stringify(settings));
    } catch (e) { /* ignore */ }
  }

  function getSettings() {
    return { ...settings };
  }

  // ══════════════════════════════════════════
  // CLOCK STYLES
  // ══════════════════════════════════════════

  const CLOCK_STYLES = ['digital', 'analog', 'word', 'binary', 'hex', 'hidden'];

  // ── Word clock logic ──

  const WORD_HOURS = [
    'twelve', 'one', 'two', 'three', 'four', 'five',
    'six', 'seven', 'eight', 'nine', 'ten', 'eleven'
  ];

  function timeToWords(h, m) {
    const h12 = h % 12;
    const nextH = (h12 + 1) % 12;

    if (m <= 2)       return WORD_HOURS[h12] + " o'clock";
    if (m <= 7)       return 'five past ' + WORD_HOURS[h12];
    if (m <= 12)      return 'ten past ' + WORD_HOURS[h12];
    if (m <= 17)      return 'quarter past ' + WORD_HOURS[h12];
    if (m <= 22)      return 'twenty past ' + WORD_HOURS[h12];
    if (m <= 27)      return 'twenty-five past ' + WORD_HOURS[h12];
    if (m <= 32)      return 'half past ' + WORD_HOURS[h12];
    if (m <= 37)      return 'twenty-five to ' + WORD_HOURS[nextH];
    if (m <= 42)      return 'twenty to ' + WORD_HOURS[nextH];
    if (m <= 47)      return 'quarter to ' + WORD_HOURS[nextH];
    if (m <= 52)      return 'ten to ' + WORD_HOURS[nextH];
    if (m <= 57)      return 'five to ' + WORD_HOURS[nextH];
    return WORD_HOURS[nextH] + " o'clock";
  }

  // ══════════════════════════════════════════
  // DOM CREATION
  // ══════════════════════════════════════════

  function injectCSS() {
    const style = document.createElement('style');
    style.id = 'ui-components-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function createSettingsButton() {
    const btn = document.createElement('button');
    btn.id = 'settings-btn';
    btn.className = 'corner-btn';
    btn.setAttribute('aria-label', 'Settings');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001.08 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1.08z"/>
    </svg>`;
    document.body.appendChild(btn);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettings();
      if (typeof wakeUp === 'function') wakeUp();
    });
    return btn;
  }

  function createDrawer() {
    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'settings-drawer-backdrop';
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', () => closeSettings());

    // Drawer
    const drawer = document.createElement('div');
    drawer.id = 'settings-drawer';
    drawer.innerHTML = `<div id="settings-drawer-inner">
      <div class="sd-title">Settings</div>

      <!-- Blob Speed -->
      <div class="sd-slider-wrap">
        <div class="sd-label">
          <span>Blob Speed</span>
          <span class="sd-label-value" id="speed-val">${settings.blobSpeed.toFixed(1)}x</span>
        </div>
        <input type="range" class="sd-slider" id="slider-speed" min="0.1" max="3" step="0.1" value="${settings.blobSpeed}">
      </div>

      <!-- Contrast / Vibrancy -->
      <div class="sd-slider-wrap">
        <div class="sd-label">
          <span>Contrast / Vibrancy</span>
          <span class="sd-label-value" id="contrast-val">${settings.contrast.toFixed(1)}</span>
        </div>
        <input type="range" class="sd-slider" id="slider-contrast" min="0.3" max="1.5" step="0.05" value="${settings.contrast}">
      </div>

      <div class="sd-divider"></div>

      <!-- Clock Style -->
      <div class="sd-label"><span>Clock Style</span></div>
      <div class="sd-btn-group" id="clock-style-group">
        <button class="sd-btn${settings.clockStyle === 'digital' ? ' active' : ''}" data-style="digital">Digital</button>
        <button class="sd-btn${settings.clockStyle === 'analog' ? ' active' : ''}" data-style="analog">Analog</button>
        <button class="sd-btn${settings.clockStyle === 'word' ? ' active' : ''}" data-style="word">Word</button>
        <button class="sd-btn${settings.clockStyle === 'binary' ? ' active' : ''}" data-style="binary">Binary</button>
        <button class="sd-btn${settings.clockStyle === 'hex' ? ' active' : ''}" data-style="hex">Hex</button>
        <button class="sd-btn${settings.clockStyle === 'hidden' ? ' active' : ''}" data-style="hidden">Hidden</button>
      </div>

      <!-- Clock Font -->
      <div class="sd-label"><span>Clock Font</span></div>
      <div class="sd-btn-group" id="clock-font-group">
        <button class="sd-btn${settings.clockFont === 'sans' ? ' active' : ''}" data-font="sans">Sans</button>
        <button class="sd-btn${settings.clockFont === 'mono' ? ' active' : ''}" data-font="mono">Mono</button>
        <button class="sd-btn${settings.clockFont === 'serif' ? ' active' : ''}" data-font="serif">Serif</button>
        <button class="sd-btn${settings.clockFont === 'pixel' ? ' active' : ''}" data-font="pixel">Pixel</button>
      </div>

      <div class="sd-divider"></div>

      <!-- Toggles -->
      <div class="sd-toggle-row">
        <span class="sd-toggle-text">Show Date</span>
        <label class="sd-toggle">
          <input type="checkbox" id="toggle-date" ${settings.showDate ? 'checked' : ''}>
          <span class="sd-toggle-track"></span>
          <span class="sd-toggle-knob"></span>
        </label>
      </div>

      <div class="sd-toggle-row">
        <span class="sd-toggle-text">Show Sun / Moon Arc</span>
        <label class="sd-toggle">
          <input type="checkbox" id="toggle-solar" ${settings.showSolarArc ? 'checked' : ''}>
          <span class="sd-toggle-track"></span>
          <span class="sd-toggle-knob"></span>
        </label>
      </div>

      <div class="sd-toggle-row">
        <span class="sd-toggle-text">Show Weather</span>
        <label class="sd-toggle">
          <input type="checkbox" id="toggle-weather" ${settings.showWeather ? 'checked' : ''}>
          <span class="sd-toggle-track"></span>
          <span class="sd-toggle-knob"></span>
        </label>
      </div>
    </div>`;

    document.body.appendChild(drawer);

    // ── Event listeners ──

    // Speed slider
    const speedSlider = drawer.querySelector('#slider-speed');
    const speedVal = drawer.querySelector('#speed-val');
    speedSlider.addEventListener('input', () => {
      resetAutoClose();
      settings.blobSpeed = parseFloat(speedSlider.value);
      speedVal.textContent = settings.blobSpeed.toFixed(1) + 'x';
      applySpeed();
      saveSettings();
    });

    // Contrast slider
    const contrastSlider = drawer.querySelector('#slider-contrast');
    const contrastVal = drawer.querySelector('#contrast-val');
    contrastSlider.addEventListener('input', () => {
      resetAutoClose();
      settings.contrast = parseFloat(contrastSlider.value);
      contrastVal.textContent = settings.contrast.toFixed(1);
      applyContrast();
      saveSettings();
    });

    // Clock style buttons
    drawer.querySelector('#clock-style-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.sd-btn');
      if (!btn) return;
      resetAutoClose();
      const style = btn.dataset.style;
      settings.clockStyle = style;
      drawer.querySelectorAll('#clock-style-group .sd-btn').forEach(b => b.classList.toggle('active', b.dataset.style === style));
      applyClockStyle();
      saveSettings();
    });

    // Clock font buttons
    drawer.querySelector('#clock-font-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.sd-btn');
      if (!btn) return;
      resetAutoClose();
      const font = btn.dataset.font;
      settings.clockFont = font;
      drawer.querySelectorAll('#clock-font-group .sd-btn').forEach(b => b.classList.toggle('active', b.dataset.font === font));
      applyClockFont();
      saveSettings();
    });

    // Toggles
    drawer.querySelector('#toggle-date').addEventListener('change', (e) => {
      resetAutoClose();
      settings.showDate = e.target.checked;
      applyDateVisibility();
      saveSettings();
    });

    drawer.querySelector('#toggle-solar').addEventListener('change', (e) => {
      resetAutoClose();
      settings.showSolarArc = e.target.checked;
      applySolarVisibility();
      saveSettings();
    });

    drawer.querySelector('#toggle-weather').addEventListener('change', (e) => {
      resetAutoClose();
      settings.showWeather = e.target.checked;
      saveSettings();
    });

    // Prevent drawer clicks from bubbling (don't close on inner click)
    drawer.addEventListener('click', (e) => e.stopPropagation());
    drawer.addEventListener('mousemove', () => resetAutoClose());

    return drawer;
  }

  function createAnalogClock() {
    const size = 260;
    const cx = size / 2;
    const cy = size / 2;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'analog-clock';
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.style.display = 'none';

    // Tick marks
    for (let i = 0; i < 12; i++) {
      const angle = (i * 30 - 90) * (Math.PI / 180);
      const outerR = 120;
      const innerR = i % 3 === 0 ? 108 : 112;
      const x1 = cx + Math.cos(angle) * innerR;
      const y1 = cy + Math.sin(angle) * innerR;
      const x2 = cx + Math.cos(angle) * outerR;
      const y2 = cy + Math.sin(angle) * outerR;
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', x1);
      tick.setAttribute('y1', y1);
      tick.setAttribute('x2', x2);
      tick.setAttribute('y2', y2);
      tick.setAttribute('stroke', 'currentColor');
      tick.setAttribute('stroke-width', i % 3 === 0 ? '1.8' : '0.8');
      tick.setAttribute('stroke-linecap', 'round');
      tick.setAttribute('opacity', '0.5');
      svg.appendChild(tick);
    }

    // Hour hand
    const hourHand = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hourHand.id = 'analog-hour';
    hourHand.setAttribute('x1', cx);
    hourHand.setAttribute('y1', cy);
    hourHand.setAttribute('x2', cx);
    hourHand.setAttribute('y2', cy - 65);
    hourHand.setAttribute('stroke', 'currentColor');
    hourHand.setAttribute('stroke-width', '2.5');
    hourHand.setAttribute('stroke-linecap', 'round');
    hourHand.setAttribute('opacity', '0.7');
    svg.appendChild(hourHand);

    // Minute hand
    const minHand = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    minHand.id = 'analog-minute';
    minHand.setAttribute('x1', cx);
    minHand.setAttribute('y1', cy);
    minHand.setAttribute('x2', cx);
    minHand.setAttribute('y2', cy - 95);
    minHand.setAttribute('stroke', 'currentColor');
    minHand.setAttribute('stroke-width', '1.5');
    minHand.setAttribute('stroke-linecap', 'round');
    minHand.setAttribute('opacity', '0.6');
    svg.appendChild(minHand);

    // Center dot
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', 'currentColor');
    dot.setAttribute('opacity', '0.4');
    svg.appendChild(dot);

    document.body.appendChild(svg);
    return svg;
  }

  function createWordClock() {
    const el = document.createElement('div');
    el.id = 'word-clock';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  function createBinaryClock() {
    const el = document.createElement('div');
    el.id = 'binary-clock';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  function createHexClock() {
    const el = document.createElement('div');
    el.id = 'hex-clock';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  function createDateDisplay() {
    const el = document.createElement('div');
    el.id = 'date-display';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  // ══════════════════════════════════════════
  // APPLY SETTINGS
  // ══════════════════════════════════════════

  function applySpeed() {
    // Modifies the global blob velocity cap used in the animation loop.
    // We expose this as a multiplier the host reads from settings.
    // The host's animate() function will read UIComponents.getSettings().blobSpeed
  }

  function applyContrast() {
    // Re-trigger palette application with contrast modifier
    if (typeof switchPalette === 'function' && typeof currentPalette !== 'undefined') {
      applyContrastToCurrentPalette();
    }
  }

  function applyContrastToCurrentPalette() {
    const pal = typeof PALETTES !== 'undefined' ? PALETTES[currentPalette] : null;
    if (!pal) return;
    const isDark = pal.dark || false;
    const c = settings.contrast;

    // Blob opacity
    const baseOpacity = isDark ? 0.55 : 1.0;
    const blobOpacity = Math.min(1, baseOpacity * c);
    if (typeof blobs !== 'undefined') {
      blobs.forEach((b) => {
        b.el.style.opacity = blobOpacity.toString();
      });
    }

    // Veil opacity - parse and scale
    const veil = document.getElementById('veil');
    if (veil) {
      // Extract rgba values from palette veil string
      const match = pal.veil.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const parts = match[1].split(',').map(s => s.trim());
        if (parts.length === 4) {
          const baseAlpha = parseFloat(parts[3]);
          const newAlpha = Math.min(1, baseAlpha * c).toFixed(3);
          veil.style.backgroundColor = `rgba(${parts[0]},${parts[1]},${parts[2]},${newAlpha})`;
        }
      }
    }
  }

  function applyClockStyle() {
    const digitalClock = document.getElementById('clock');
    const analogClock = document.getElementById('analog-clock');
    const wordClock = document.getElementById('word-clock');
    const binaryClock = document.getElementById('binary-clock');
    const hexClock = document.getElementById('hex-clock');

    // Hide all
    if (digitalClock) digitalClock.style.display = 'none';
    if (analogClock)  analogClock.style.display = 'none';
    if (wordClock)    wordClock.style.display = 'none';
    if (binaryClock)  binaryClock.style.display = 'none';
    if (hexClock)     hexClock.style.display = 'none';

    // Cancel analog animation if running
    if (analogAnimFrame) {
      cancelAnimationFrame(analogAnimFrame);
      analogAnimFrame = null;
    }

    switch (settings.clockStyle) {
      case 'digital':
        if (digitalClock) digitalClock.style.display = '';
        break;
      case 'analog':
        if (analogClock) analogClock.style.display = '';
        startAnalogAnimation();
        break;
      case 'word':
        if (wordClock) wordClock.style.display = '';
        break;
      case 'binary':
        if (binaryClock) binaryClock.style.display = '';
        break;
      case 'hex':
        if (hexClock) hexClock.style.display = '';
        break;
      case 'hidden':
        // All hidden
        break;
    }

    // Force an immediate update
    updateClockDisplay();
    updateDateDisplay();
  }

  function applyClockFont() {
    const fontClass = 'font-' + settings.clockFont;
    const allClocks = ['clock', 'word-clock', 'binary-clock', 'hex-clock'];
    allClocks.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('font-sans', 'font-mono', 'font-serif', 'font-pixel');
      el.classList.add(fontClass);
    });
  }

  function applyDateVisibility() {
    const dateEl = document.getElementById('date-display');
    if (!dateEl) return;
    dateEl.style.display = settings.showDate ? '' : 'none';
    if (settings.showDate) updateDateDisplay();
  }

  function applySolarVisibility() {
    const solarInfo = document.getElementById('solar-info');
    if (!solarInfo) return;
    solarInfo.style.display = settings.showSolarArc ? '' : 'none';
  }

  // ══════════════════════════════════════════
  // CLOCK DISPLAY UPDATES
  // ══════════════════════════════════════════

  function updateClockDisplay() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const s = now.getSeconds();

    // Word clock
    const wordClock = document.getElementById('word-clock');
    if (wordClock && settings.clockStyle === 'word') {
      wordClock.textContent = timeToWords(h, m);
    }

    // Binary clock: show hours and minutes in binary
    const binaryClock = document.getElementById('binary-clock');
    if (binaryClock && settings.clockStyle === 'binary') {
      const hBin = h.toString(2).padStart(5, '0');
      const mBin = m.toString(2).padStart(6, '0');
      binaryClock.textContent = hBin + ' : ' + mBin;
    }

    // Hex clock
    const hexClock = document.getElementById('hex-clock');
    if (hexClock && settings.clockStyle === 'hex') {
      hexClock.textContent = '#' + h.toString(16).padStart(2, '0') + m.toString(16).padStart(2, '0') + s.toString(16).padStart(2, '0');
    }
  }

  function updateDateDisplay() {
    const dateEl = document.getElementById('date-display');
    if (!dateEl || !settings.showDate) return;

    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    dateEl.textContent = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate();
  }

  // ══════════════════════════════════════════
  // ANALOG CLOCK ANIMATION
  // ══════════════════════════════════════════

  function startAnalogAnimation() {
    const svg = document.getElementById('analog-clock');
    if (!svg) return;

    const cx = 130;
    const cy = 130;
    const hourHand = svg.querySelector('#analog-hour');
    const minHand  = svg.querySelector('#analog-minute');

    function tick() {
      const now = new Date();
      const h = now.getHours() % 12;
      const m = now.getMinutes();
      const s = now.getSeconds();
      const ms = now.getMilliseconds();

      // Smooth continuous movement
      const totalSeconds = s + ms / 1000;
      const totalMinutes = m + totalSeconds / 60;
      const totalHours = h + totalMinutes / 60;

      const minAngle = (totalMinutes / 60) * 360 - 90;
      const hourAngle = (totalHours / 12) * 360 - 90;

      const minRad = minAngle * (Math.PI / 180);
      const hourRad = hourAngle * (Math.PI / 180);

      const minLen = 95;
      const hourLen = 65;

      hourHand.setAttribute('x2', cx + Math.cos(hourRad) * hourLen);
      hourHand.setAttribute('y2', cy + Math.sin(hourRad) * hourLen);

      minHand.setAttribute('x2', cx + Math.cos(minRad) * minLen);
      minHand.setAttribute('y2', cy + Math.sin(minRad) * minLen);

      analogAnimFrame = requestAnimationFrame(tick);
    }

    tick();
  }

  // ══════════════════════════════════════════
  // PALETTE INTEGRATION (color sync)
  // ══════════════════════════════════════════

  function syncColorsWithPalette() {
    if (typeof PALETTES === 'undefined' || typeof currentPalette === 'undefined') return;
    const pal = PALETTES[currentPalette];
    const isDark = pal.dark || false;
    const baseOpacity = isDark ? 0.75 : 0.70;
    const dateOpacity = isDark ? 0.45 : 0.40;

    const analogClock = document.getElementById('analog-clock');
    const wordClock = document.getElementById('word-clock');
    const binaryClock = document.getElementById('binary-clock');
    const hexClock = document.getElementById('hex-clock');
    const dateDisplay = document.getElementById('date-display');

    if (analogClock) {
      analogClock.style.color = pal.clockColor;
      analogClock.style.opacity = baseOpacity;
    }
    if (wordClock) {
      wordClock.style.color = pal.clockColor;
      wordClock.style.opacity = baseOpacity;
    }
    if (binaryClock) {
      binaryClock.style.color = pal.clockColor;
      binaryClock.style.opacity = baseOpacity;
    }
    if (hexClock) {
      hexClock.style.color = pal.clockColor;
      hexClock.style.opacity = baseOpacity;
    }
    if (dateDisplay) {
      dateDisplay.style.color = pal.clockColor;
      dateDisplay.style.opacity = dateOpacity;
    }

    // Also apply contrast adjustments
    applyContrastToCurrentPalette();
  }

  // ══════════════════════════════════════════
  // DRAWER OPEN / CLOSE
  // ══════════════════════════════════════════

  function openSettings() {
    const drawer = document.getElementById('settings-drawer');
    const backdrop = document.getElementById('settings-drawer-backdrop');
    if (!drawer) return;
    drawerOpen = true;
    drawer.classList.add('open');
    if (backdrop) backdrop.classList.add('visible');
    resetAutoClose();
  }

  function closeSettings() {
    const drawer = document.getElementById('settings-drawer');
    const backdrop = document.getElementById('settings-drawer-backdrop');
    if (!drawer) return;
    drawerOpen = false;
    drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('visible');
    clearTimeout(drawerAutoCloseTimer);
    drawerAutoCloseTimer = null;
  }

  function toggleSettings() {
    if (drawerOpen) closeSettings();
    else openSettings();
  }

  function resetAutoClose() {
    clearTimeout(drawerAutoCloseTimer);
    drawerAutoCloseTimer = setTimeout(() => {
      if (drawerOpen) closeSettings();
    }, 5000);
  }

  // ══════════════════════════════════════════
  // KEYBOARD HOOKS
  // ══════════════════════════════════════════

  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        toggleSettings();
      } else if (key === 'escape' && drawerOpen) {
        e.preventDefault();
        closeSettings();
      }
    });
  }

  // ══════════════════════════════════════════
  // MONKEY-PATCH HOST FUNCTIONS
  // ══════════════════════════════════════════

  function patchHost() {
    // The host's functions (switchPalette, updateClock) are declared with `function`
    // at top-level in an inline <script>, making them global. However, the host's own
    // event handlers and setInterval calls capture the original function references
    // via closure, so a simple window.switchPalette override won't intercept those
    // internal calls. Instead, we use observation-based approaches:

    // 1. Watch for palette changes by observing the clock element's style.color
    //    (the host sets clock.style.color = pal.clockColor on every palette switch).
    let lastObservedClockColor = '';
    const clockEl = document.getElementById('clock');
    if (clockEl) {
      const paletteObserver = new MutationObserver(() => {
        const currentColor = clockEl.style.color;
        if (currentColor !== lastObservedClockColor) {
          lastObservedClockColor = currentColor;
          syncColorsWithPalette();
        }
      });
      paletteObserver.observe(clockEl, { attributes: true, attributeFilter: ['style'] });
      lastObservedClockColor = clockEl.style.color;
    }

    // 2. Clock updates are handled by our own setInterval in init(), so no
    //    patching of updateClock is needed.

    // Speed multiplier: scale blob velocities each frame.
    // The host's animate() reads b.vx/b.vy and applies `* 0.42` as movement.
    // We inject a secondary animation frame that scales vx/vy before the host
    // reads them, and un-scales after. Since rAF callbacks run in order of
    // registration, we instead use a simpler approach: store base wobble
    // and scale it, plus scale vx/vy directly each frame through a post-hook
    // that compounds the speed difference.
    //
    // Cleanest approach: wrap the blobs' velocity accumulation by overriding
    // the position update. We'll run our own rAF that applies an EXTRA velocity
    // nudge proportional to (speedMult - 1.0) to simulate the speed change.

    if (typeof blobs !== 'undefined') {
      blobs.forEach(b => {
        b._baseWobble = b.wobble;
      });
    }

    let prevSpeedMult = 1.0;

    function speedHook() {
      requestAnimationFrame(speedHook);

      const speedMult = settings.blobSpeed;
      if (typeof blobs === 'undefined') return;

      // Update wobble rate when speed changes
      if (speedMult !== prevSpeedMult) {
        blobs.forEach(b => {
          if (b._baseWobble) {
            b.wobble = b._baseWobble * speedMult;
          }
        });
        prevSpeedMult = speedMult;
      }

      // Apply extra movement: the host moves by vx*0.42 per frame.
      // We want total movement = vx * 0.42 * speedMult.
      // Host already does vx * 0.42 (= 1x), so we add vx * 0.42 * (speedMult - 1).
      const extra = speedMult - 1.0;
      if (Math.abs(extra) > 0.001) {
        blobs.forEach(b => {
          b.x += b.vx * 0.42 * extra;
          b.y += b.vy * 0.42 * extra;

          // Re-apply bounds (same as host)
          const pad = 12;
          if (b.x < pad) { b.x = pad; b.vx = Math.abs(b.vx) * 0.82; }
          if (b.x > 100 - pad) { b.x = 100 - pad; b.vx = -Math.abs(b.vx) * 0.82; }
          if (b.y < pad) { b.y = pad; b.vy = Math.abs(b.vy) * 0.82; }
          if (b.y > 100 - pad) { b.y = 100 - pad; b.vy = -Math.abs(b.vy) * 0.82; }
        });
      }
    }

    requestAnimationFrame(speedHook);

    // Update the hint text to include S shortcut
    const hint = document.getElementById('hint');
    if (hint) {
      hint.textContent = 'F \u00b7 fullscreen   \u2190 \u2192 \u00b7 palettes   scroll \u00b7 cycle   S \u00b7 settings';
    }
  }

  // ══════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════

  function init() {
    loadSettings();
    injectCSS();
    createSettingsButton();
    createDrawer();
    createAnalogClock();
    createWordClock();
    createBinaryClock();
    createHexClock();
    createDateDisplay();
    setupKeyboard();
    patchHost();

    // Apply all settings
    applyClockStyle();
    applyClockFont();
    applyDateVisibility();
    applySolarVisibility();
    syncColorsWithPalette();
    applyContrastToCurrentPalette();

    // Set up periodic clock/date updates (in addition to host's interval)
    setInterval(() => {
      updateClockDisplay();
      updateDateDisplay();
    }, 1000);

    // Hex clock needs faster updates for second-precision
    setInterval(() => {
      if (settings.clockStyle === 'hex') {
        updateClockDisplay();
      }
    }, 250);
  }

  // ══════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════

  return {
    init,
    updateClockDisplay,
    openSettings,
    closeSettings,
    toggleSettings,
    getSettings,
    syncColorsWithPalette,
  };

})();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => UIComponents.init());
} else {
  UIComponents.init();
}
