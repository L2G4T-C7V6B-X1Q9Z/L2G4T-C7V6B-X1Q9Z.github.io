// ══════════════════════════════════════════════════════════════
// celestial.js — Blobscape Celestial Module
// Weather glyph, sun/moon arcs, binary/hex clock modes
// ══════════════════════════════════════════════════════════════

const Celestial = (function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────
  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const WEATHER_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

  // Weather code → glyph mapping
  const WEATHER_GLYPHS = {
    0: '☀',         // Clear sky
    1: '⛅', 2: '⛅', 3: '☁',   // Partly cloudy → overcast
    45: '🌫', 48: '🌫',          // Fog / depositing rime fog
    51: '🌧', 53: '🌧', 55: '🌧', // Drizzle
    56: '🌧', 57: '🌧',          // Freezing drizzle
    61: '🌧', 63: '🌧', 65: '🌧', // Rain
    66: '🌧', 67: '🌧',          // Freezing rain
    71: '❄', 73: '❄', 75: '❄',  // Snowfall
    77: '❄',                      // Snow grains
    80: '🌧', 81: '🌧', 82: '🌧', // Rain showers
    85: '❄', 86: '❄',            // Snow showers
    95: '⛈',                      // Thunderstorm
    96: '⛈', 99: '⛈',            // Thunderstorm with hail
  };

  // Moon phase glyphs (8 phases, indexed 0–7)
  const MOON_GLYPHS = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];


  // ══════════════════════════════════════════════════════════
  // 1. WEATHER GLYPH
  // ══════════════════════════════════════════════════════════

  let weatherEl = null;
  let weatherTimer = null;
  let lastWeatherData = null;

  /**
   * Create the weather widget DOM element.
   * Mirrors the #solar-info style in the bottom-left, but placed bottom-right.
   */
  function createWeatherElement() {
    if (weatherEl) return weatherEl;

    weatherEl = document.createElement('div');
    weatherEl.id = 'celestial-weather';
    Object.assign(weatherEl.style, {
      position: 'fixed',
      bottom: '24px',
      right: '28px',
      zIndex: '5',
      pointerEvents: 'none',
      opacity: '0',                    // start hidden, fade in on data
      transition: 'color 1.2s ease, opacity 1.2s ease',
      fontFamily: "'Inter', -apple-system, 'Segoe UI', sans-serif",
      fontVariantNumeric: 'tabular-nums',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '13px',
      fontWeight: '400',
      letterSpacing: '0.02em',
      lineHeight: '1.6',
    });

    document.body.appendChild(weatherEl);
    return weatherEl;
  }

  /**
   * Fetch weather from Open-Meteo for the given coordinates.
   * Returns { temperature, unit, weatherCode } or null on failure.
   */
  async function fetchWeather(lat, lon) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        temperature: Math.round(data.current.temperature_2m),
        unit: data.current_units.temperature_2m,
        weatherCode: data.current.weather_code,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Render weather data into the widget element.
   */
  function renderWeather(data) {
    if (!weatherEl) return;
    if (!data) {
      weatherEl.style.opacity = '0';
      return;
    }

    const glyph = WEATHER_GLYPHS[data.weatherCode] || '☀';
    const temp = `${data.temperature}${data.unit}`;

    weatherEl.innerHTML =
      `<span style="font-size:11px; opacity:0.7;">${glyph}</span>` +
      `<span style="font-weight:500; letter-spacing:0.04em;">${temp}</span>`;

    // Match current palette opacity (mirrors #solar-info behavior)
    const solarInfo = document.getElementById('solar-info');
    if (solarInfo) {
      weatherEl.style.color = solarInfo.style.color || '';
      weatherEl.style.opacity = solarInfo.style.opacity || '0.42';
    } else {
      weatherEl.style.opacity = '0.42';
    }

    lastWeatherData = data;
  }

  /**
   * Initialize the weather widget. Call once after the app has started.
   * Requires global `userLat` and `userLon` to be set.
   */
  function initWeather() {
    createWeatherElement();
    updateWeather();
    // Set up periodic refresh
    if (weatherTimer) clearInterval(weatherTimer);
    weatherTimer = setInterval(updateWeather, WEATHER_REFRESH_MS);
  }

  /**
   * Single update cycle: check for coords, fetch, render.
   */
  async function updateWeather() {
    // Access the global userLat / userLon from the main app
    const lat = typeof userLat !== 'undefined' ? userLat : null;
    const lon = typeof userLon !== 'undefined' ? userLon : null;

    if (lat === null || lon === null) {
      // No geolocation — hide widget entirely
      if (weatherEl) weatherEl.style.opacity = '0';
      return;
    }

    const data = await fetchWeather(lat, lon);
    renderWeather(data);
  }

  /**
   * Re-sync weather widget colors with the current palette.
   * Call this from switchPalette() in the main app.
   */
  function syncWeatherStyle() {
    if (!weatherEl || !lastWeatherData) return;
    const solarInfo = document.getElementById('solar-info');
    if (solarInfo) {
      weatherEl.style.color = solarInfo.style.color || '';
      weatherEl.style.opacity = solarInfo.style.opacity || '0.42';
    }
  }


  // ══════════════════════════════════════════════════════════
  // 2. SUN POSITION ARC
  // ══════════════════════════════════════════════════════════

  let sunArcSvg = null;
  let sunDot = null;
  let sunArcPath = null;

  // Arc geometry: a shallow parabolic arc from left edge to right edge
  // across the top of the viewport
  const ARC_PADDING_X = 40;  // px from edges
  const ARC_TOP_Y = 60;      // px from top at apex
  const ARC_BASE_Y = 200;    // px from top at dawn/dusk endpoints

  /**
   * Create the SVG overlay for the sun arc.
   */
  function createSunArc() {
    if (sunArcSvg) return;

    sunArcSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sunArcSvg.setAttribute('id', 'celestial-sun-arc');
    Object.assign(sunArcSvg.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '260px',
      pointerEvents: 'none',
      zIndex: '4',
      overflow: 'visible',
    });

    // The arc path (quadratic bezier)
    sunArcPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    sunArcPath.setAttribute('fill', 'none');
    sunArcPath.setAttribute('stroke', 'currentColor');
    sunArcPath.setAttribute('stroke-width', '1');
    sunArcPath.setAttribute('stroke-dasharray', '4 6');
    Object.assign(sunArcPath.style, {
      opacity: '0.04',
      transition: 'opacity 1.2s ease',
    });
    sunArcSvg.appendChild(sunArcPath);

    // The sun dot
    sunDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    sunDot.setAttribute('r', '4');
    sunDot.setAttribute('fill', 'currentColor');
    Object.assign(sunDot.style, {
      opacity: '0',
      transition: 'opacity 1.2s ease, cx 60s linear, cy 60s linear',
    });
    sunArcSvg.appendChild(sunDot);

    document.body.appendChild(sunArcSvg);
    updateSunArcPath();
  }

  /**
   * Recalculate the SVG arc path on resize.
   */
  function updateSunArcPath() {
    if (!sunArcPath) return;
    const w = window.innerWidth;
    const x0 = ARC_PADDING_X;
    const x1 = w - ARC_PADDING_X;
    const xMid = w / 2;

    // Quadratic bezier: start at left-base, peak at center-top, end at right-base
    const d = `M ${x0} ${ARC_BASE_Y} Q ${xMid} ${ARC_TOP_Y - 60} ${x1} ${ARC_BASE_Y}`;
    sunArcPath.setAttribute('d', d);
  }

  /**
   * Compute a point along the quadratic bezier at parameter t (0–1).
   */
  function bezierPoint(t) {
    const w = window.innerWidth;
    const x0 = ARC_PADDING_X;
    const x1 = w - ARC_PADDING_X;
    const xMid = w / 2;

    // Control points for Q: P0=(x0, ARC_BASE_Y), P1=(xMid, ARC_TOP_Y-60), P2=(x1, ARC_BASE_Y)
    const mt = 1 - t;
    const px = mt * mt * x0 + 2 * mt * t * xMid + t * t * x1;
    const py = mt * mt * ARC_BASE_Y + 2 * mt * t * (ARC_TOP_Y - 60) + t * t * ARC_BASE_Y;
    return { x: px, y: py };
  }

  /**
   * Update the sun dot position along the arc.
   * t = 0 at sunrise, t = 0.5 at solar noon, t = 1 at sunset.
   * Below horizon (t < 0 or t > 1): show very faintly below the arc.
   */
  function updateSunArc() {
    if (!sunDot || !sunArcPath) return;

    const lat = typeof userLat !== 'undefined' ? userLat : null;
    const lon = typeof userLon !== 'undefined' ? userLon : null;
    if (lat === null || lon === null) {
      sunArcPath.style.opacity = '0';
      sunDot.style.opacity = '0';
      return;
    }

    const now = new Date();
    const solar = solarTimes(lat, lon, now);

    // Handle polar conditions
    if (solar.polarDay || solar.polarNight) {
      sunArcPath.style.opacity = '0.02';
      sunDot.style.opacity = solar.polarDay ? '0.08' : '0';
      if (solar.polarDay) {
        // Show dot at top center for polar day
        const pt = bezierPoint(0.5);
        sunDot.setAttribute('cx', pt.x);
        sunDot.setAttribute('cy', pt.y);
      }
      return;
    }

    const riseLocal = utcMinToLocal(solar.rise, now);
    const setLocal = utcMinToLocal(solar.set, now);
    const nowMin = minutesSinceMidnight(now);

    // Duration of daylight
    let dayLength = setLocal - riseLocal;
    if (dayLength <= 0) dayLength += 1440;

    // How far through the day are we?
    let elapsed = nowMin - riseLocal;
    if (elapsed < -720) elapsed += 1440; // handle wrap
    const t = elapsed / dayLength;

    // Show the arc path faintly
    sunArcPath.style.opacity = '0.04';

    // Sync color with palette
    syncArcColors();

    if (t >= 0 && t <= 1) {
      // Sun is above horizon
      const pt = bezierPoint(t);
      sunDot.setAttribute('cx', pt.x);
      sunDot.setAttribute('cy', pt.y);
      sunDot.style.opacity = '0.12';
    } else {
      // Sun is below horizon — show faintly at the edge
      // Place it at the nearest arc endpoint, slightly below
      const edgeT = t < 0 ? 0 : 1;
      const pt = bezierPoint(edgeT);
      sunDot.setAttribute('cx', pt.x);
      sunDot.setAttribute('cy', pt.y + 20);
      sunDot.style.opacity = '0.03';
    }
  }

  /**
   * Sync arc element colors with the current palette's clock color.
   */
  function syncArcColors() {
    const clockEl = document.getElementById('clock');
    if (!clockEl) return;
    const color = clockEl.style.color || '#000';
    if (sunArcSvg) sunArcSvg.style.color = color;
    if (moonArcSvg) moonArcSvg.style.color = color;
  }


  // ══════════════════════════════════════════════════════════
  // 3. MOON POSITION ARC
  // ══════════════════════════════════════════════════════════

  let moonArcSvg = null;
  let moonDot = null;
  let moonArcPath = null;
  let moonGlyphEl = null;

  // Moon arc: same shape but at the bottom of the screen, inverted
  const MOON_ARC_BOTTOM_Y_OFFSET = 80;  // px from bottom at endpoints
  const MOON_ARC_APEX_OFFSET = 200;     // px from bottom at apex (top of arc)

  /**
   * Simplified moon position algorithm.
   * Returns { riseMin, setMin, phaseIndex } in UTC minutes from midnight.
   *
   * This uses a simplified calculation based on the moon's synodic period
   * and an approximation of rise/set times relative to the sun.
   */
  function moonData(lat, lon, date) {
    // ── Moon phase calculation ──
    // Known new moon: 2000-01-06 18:14 UTC (Julian Day 2451550.26)
    const SYNODIC = 29.53058868;   // days per lunar cycle
    const jd = julianDay(date);
    const daysSinceNewMoon = jd - 2451550.26;
    const lunarAge = ((daysSinceNewMoon % SYNODIC) + SYNODIC) % SYNODIC; // 0 = new moon
    const phaseFraction = lunarAge / SYNODIC; // 0..1

    // Phase index: 0=new, 1=waxing crescent, ... 4=full, ... 7=waning crescent
    const phaseIndex = Math.floor(phaseFraction * 8) % 8;

    // ── Simplified moonrise / moonset ──
    // The moon rises ~50 minutes later each day relative to the sun.
    // At new moon, it roughly rises/sets with the sun.
    // At full moon, it roughly rises at sunset and sets at sunrise.
    //
    // Approximate: moonrise = sunrise + phaseFraction * dayLength + (1 - phaseFraction) * nightStart
    // Simpler model: moonrise ≈ sunrise + lunarAge * 50.47 minutes
    // moonset ≈ moonrise + ~12.4 hours (average moon above horizon)

    const solar = solarTimes(lat, lon, date);
    if (solar.polarDay || solar.polarNight || solar.rise === null) {
      return { riseMin: null, setMin: null, phaseIndex, phaseFraction };
    }

    const sunRiseUTC = solar.rise;

    // Moon delay from sun: each day of the lunar cycle adds ~50.47 minutes
    const moonDelay = lunarAge * (1440 / SYNODIC); // ≈ 48.76 min/day
    const moonRiseUTC = (sunRiseUTC + moonDelay) % 1440;

    // Average duration the moon is above the horizon: ~12.4 hours
    // This varies with declination, but this is a reasonable approximation
    const MOON_VISIBLE_DURATION = 12.4 * 60; // 744 minutes
    const moonSetUTC = (moonRiseUTC + MOON_VISIBLE_DURATION) % 1440;

    return {
      riseMin: moonRiseUTC,
      setMin: moonSetUTC,
      phaseIndex,
      phaseFraction,
    };
  }

  /**
   * Create the SVG overlay for the moon arc.
   * This arc sits at the bottom of the viewport, arcing upward (inverted from the sun).
   */
  function createMoonArc() {
    if (moonArcSvg) return;

    moonArcSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    moonArcSvg.setAttribute('id', 'celestial-moon-arc');
    Object.assign(moonArcSvg.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      width: '100vw',
      height: '260px',
      pointerEvents: 'none',
      zIndex: '4',
      overflow: 'visible',
    });

    // The arc path
    moonArcPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    moonArcPath.setAttribute('fill', 'none');
    moonArcPath.setAttribute('stroke', 'currentColor');
    moonArcPath.setAttribute('stroke-width', '1');
    moonArcPath.setAttribute('stroke-dasharray', '4 6');
    Object.assign(moonArcPath.style, {
      opacity: '0.03',
      transition: 'opacity 1.2s ease',
    });
    moonArcSvg.appendChild(moonArcPath);

    // Moon phase glyph used as the dot
    moonGlyphEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    moonGlyphEl.setAttribute('font-size', '14');
    moonGlyphEl.setAttribute('text-anchor', 'middle');
    moonGlyphEl.setAttribute('dominant-baseline', 'central');
    Object.assign(moonGlyphEl.style, {
      opacity: '0',
      transition: 'opacity 1.2s ease',
    });
    moonArcSvg.appendChild(moonGlyphEl);

    document.body.appendChild(moonArcSvg);
    updateMoonArcPath();
  }

  /**
   * Recalculate the moon arc path (inverted arc at bottom of screen).
   * Coordinate system: SVG is 260px tall, pinned to the bottom.
   * y=0 is 260px from the bottom of the viewport, y=260 is the very bottom.
   */
  function updateMoonArcPath() {
    if (!moonArcPath) return;
    const w = window.innerWidth;
    const h = 260; // SVG height
    const x0 = ARC_PADDING_X;
    const x1 = w - ARC_PADDING_X;
    const xMid = w / 2;

    // Endpoints near the bottom, apex higher up
    const yBase = h - MOON_ARC_BOTTOM_Y_OFFSET;      // 180 — near bottom
    const yApex = h - MOON_ARC_APEX_OFFSET;           // 60  — higher up

    // Quadratic bezier control point (needs to be above apex for proper curve)
    const yCp = yApex - (yBase - yApex);              // mirror

    const d = `M ${x0} ${yBase} Q ${xMid} ${yCp} ${x1} ${yBase}`;
    moonArcPath.setAttribute('d', d);
  }

  /**
   * Compute a point along the moon's quadratic bezier at parameter t (0–1).
   */
  function moonBezierPoint(t) {
    const w = window.innerWidth;
    const h = 260;
    const x0 = ARC_PADDING_X;
    const x1 = w - ARC_PADDING_X;
    const xMid = w / 2;

    const yBase = h - MOON_ARC_BOTTOM_Y_OFFSET;
    const yApex = h - MOON_ARC_APEX_OFFSET;
    const yCp = yApex - (yBase - yApex);

    const mt = 1 - t;
    const px = mt * mt * x0 + 2 * mt * t * xMid + t * t * x1;
    const py = mt * mt * yBase + 2 * mt * t * yCp + t * t * yBase;
    return { x: px, y: py };
  }

  /**
   * Update the moon glyph position along its arc.
   */
  function updateMoonArc() {
    if (!moonGlyphEl || !moonArcPath) return;

    const lat = typeof userLat !== 'undefined' ? userLat : null;
    const lon = typeof userLon !== 'undefined' ? userLon : null;
    if (lat === null || lon === null) {
      moonArcPath.style.opacity = '0';
      moonGlyphEl.style.opacity = '0';
      return;
    }

    const now = new Date();
    const moon = moonData(lat, lon, now);

    // Set the phase glyph
    moonGlyphEl.textContent = MOON_GLYPHS[moon.phaseIndex];

    if (moon.riseMin === null) {
      moonArcPath.style.opacity = '0.02';
      moonGlyphEl.style.opacity = '0';
      return;
    }

    const riseLocal = utcMinToLocal(moon.riseMin, now);
    const setLocal = utcMinToLocal(moon.setMin, now);
    const nowMin = minutesSinceMidnight(now);

    // Compute how far through the moon's above-horizon time we are
    let duration = setLocal - riseLocal;
    if (duration <= 0) duration += 1440;

    let elapsed = nowMin - riseLocal;
    if (elapsed < -720) elapsed += 1440;
    if (elapsed > 720) elapsed -= 1440;

    const t = elapsed / duration;

    // Show the arc path faintly
    moonArcPath.style.opacity = '0.03';

    syncArcColors();

    if (t >= 0 && t <= 1) {
      // Moon is above horizon
      const pt = moonBezierPoint(t);
      moonGlyphEl.setAttribute('x', pt.x);
      moonGlyphEl.setAttribute('y', pt.y);
      moonGlyphEl.style.opacity = '0.10';
    } else {
      // Moon is below horizon — show faintly at nearest edge
      const edgeT = t < 0 ? 0 : 1;
      const pt = moonBezierPoint(edgeT);
      moonGlyphEl.setAttribute('x', pt.x);
      moonGlyphEl.setAttribute('y', pt.y + 15);
      moonGlyphEl.style.opacity = '0.025';
    }
  }


  // ══════════════════════════════════════════════════════════
  // 4. BINARY / HEX / UNIX CLOCK MODES
  // ══════════════════════════════════════════════════════════

  /**
   * Format the current time as a binary string: "HHHHHH:MMMMMM"
   * Hours (0–23) use 5 bits, minutes (0–59) use 6 bits.
   */
  function formatBinary(date) {
    const d = date || new Date();
    const h = d.getHours().toString(2).padStart(5, '0');
    const m = d.getMinutes().toString(2).padStart(6, '0');
    return `${h}:${m}`;
  }

  /**
   * Format the current time as hexadecimal: "HH:MM"
   * (e.g., 20:50 → "14:32")
   */
  function formatHex(date) {
    const d = date || new Date();
    const h = d.getHours().toString(16).toUpperCase().padStart(2, '0');
    const m = d.getMinutes().toString(16).toUpperCase().padStart(2, '0');
    return `${h}:${m}`;
  }

  /**
   * Format the current time as a Unix epoch timestamp.
   */
  function formatUnix(date) {
    const d = date || new Date();
    return Math.floor(d.getTime() / 1000).toString();
  }

  /**
   * Get the formatted time string for a given mode.
   * @param {'standard'|'binary'|'hex'|'unix'} mode
   * @param {Date} [date] — optional, defaults to now
   * @returns {string}
   */
  function formatClock(mode, date) {
    const d = date || new Date();
    switch (mode) {
      case 'binary': return formatBinary(d);
      case 'hex':    return formatHex(d);
      case 'unix':   return formatUnix(d);
      case 'standard':
      default: {
        const h = d.getHours().toString().padStart(2, '0');
        const m = d.getMinutes().toString().padStart(2, '0');
        return `${h}:${m}`;
      }
    }
  }

  // The available clock modes in cycle order
  const CLOCK_MODES = ['standard', 'binary', 'hex', 'unix'];
  let currentClockMode = 0;

  /**
   * Cycle to the next clock mode. Returns the new mode name.
   */
  function cycleClockMode() {
    currentClockMode = (currentClockMode + 1) % CLOCK_MODES.length;
    return CLOCK_MODES[currentClockMode];
  }

  /**
   * Get the current clock mode name.
   */
  function getClockMode() {
    return CLOCK_MODES[currentClockMode];
  }

  /**
   * Set the clock mode directly.
   * @param {'standard'|'binary'|'hex'|'unix'} mode
   */
  function setClockMode(mode) {
    const idx = CLOCK_MODES.indexOf(mode);
    if (idx !== -1) currentClockMode = idx;
  }


  // ══════════════════════════════════════════════════════════
  // INITIALIZATION & UPDATE LOOP
  // ══════════════════════════════════════════════════════════

  let initialized = false;
  let updateInterval = null;

  /**
   * Initialize all celestial features. Call once after the main app is ready.
   * This creates DOM elements and starts the update loops.
   */
  function init() {
    if (initialized) return;
    initialized = true;

    // Create visual elements (arcs are off by default, created on demand)
    createWeatherElement();

    // Initial updates
    updateWeather();

    // Periodic weather refresh
    if (weatherTimer) clearInterval(weatherTimer);
    weatherTimer = setInterval(updateWeather, WEATHER_REFRESH_MS);

    // Arc updates are only started when arcs are enabled via settings
  }

  /**
   * Call this from the main app's switchPalette() to keep celestial
   * elements in sync with the current color scheme.
   */
  function onPaletteChange() {
    syncWeatherStyle();
    syncArcColors();
  }

  /**
   * Force an immediate update of all celestial elements.
   * Useful after geolocation becomes available.
   */
  function refresh() {
    updateSunArc();
    updateMoonArc();
    updateWeather();
  }


  // ── Public API ─────────────────────────────────────────────
  return {
    // Initialization
    init,
    refresh,
    onPaletteChange,

    // Weather
    initWeather,
    updateWeather,
    syncWeatherStyle,

    // Sun arc
    updateSunArc,

    // Moon arc
    updateMoonArc,
    moonData,

    // Clock modes
    formatClock,
    formatBinary,
    formatHex,
    formatUnix,
    cycleClockMode,
    getClockMode,
    setClockMode,
    CLOCK_MODES,
  };
})();
