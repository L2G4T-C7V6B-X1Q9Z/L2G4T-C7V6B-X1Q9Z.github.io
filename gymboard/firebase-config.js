// =============================================================================
// gymboard — Firebase web config (REAL, live values)
// -----------------------------------------------------------------------------
// Generated for the live project "gymboard-342f9". This file is gitignored.
// The web config below is NOT secret (it is a project identifier, shipped public
// by design). The authorization boundary is the Firestore Security Rules.
//
// App Check is intentionally SKIPPED for now (no reCAPTCHA key), so
// recaptchaSiteKey is empty. Data privacy is still enforced by the rules; App
// Check only adds abuse/quota-drain protection and can be added later with no
// code change (create a reCAPTCHA v3 key, set recaptchaSiteKey below, enforce in
// the console).
// =============================================================================

// ---- Firebase project web config -------------------------------------------
export const firebaseConfig = {
  apiKey: 'AIzaSyBXsuIyf9mVBBktKlK_as5CVFAghJk8GLA',       // project identifier, NOT a secret
  authDomain: 'gymboard-342f9.firebaseapp.com',
  projectId: 'gymboard-342f9',
  storageBucket: 'gymboard-342f9.firebasestorage.app',     // unused in Phase 1 (no Storage)
  messagingSenderId: '876087150276',
  appId: '1:876087150276:web:6a81290e50ab0a9e4ceb91',
};

// ---- App Check (reCAPTCHA v3) site key --------------------------------------
// SKIPPED for now. Empty string => App Check is not initialized. To enable later:
// create a reCAPTCHA v3 site key, paste it here, and enforce App Check on Cloud
// Firestore + Authentication in the Firebase console.
export const recaptchaSiteKey = '';

// ---- Optional: App Check debug token (LOCAL DEV ONLY) -----------------------
export const appCheckDebugToken = undefined;
