// ========================================
// Speed Reader - Ultralight Edition
// ========================================

class SpeedReader {
    constructor() {
        // Settings
        this.settings = {
            theme: 'dark',
            fontSize: 32,
            contextWords: 1,
            removeBrackets: true,  // New setting for bracket removal
            adaptiveTiming: false,  // Variable timing based on word length/punctuation
            sentencePause: false,   // Add pause at end of sentences
            bionicReading: false,   // Bionic reading style (bold first letters)
            thockVolume: 0.7,       // Volume for thock sound (0-1, default 0.7)
            baseWPM: 350,
            minWPM: 250,
            maxWPM: 1200
        };

        // Audio context for thock sound
        this.audioContext = null;

        // State
        this.text = '';
        this.words = [];
        this.paragraphs = [];
        this.currentIndex = 0;
        this.currentParagraph = 0;
        this.isPlaying = false;
        this.isPaused = false;
        this.currentWPM = this.settings.baseWPM;
        this.markers = [];
        this.isRevActive = false;

        // Timing & Stats
        this.nextWordTimeout = null;
        this.lastWordTime = Date.now();
        this.startTime = null;
        this.totalReadingTime = 0;

        this.init();
    }

    init() {
        this.loadSettings();
        this.applyTheme(); // Apply theme immediately before other setup
        this.setupElements();
        this.setupEventListeners();
        this.applySettings();
    }

    setupElements() {
        // Screens
        this.inputScreen = document.getElementById('input-screen');
        this.readingScreen = document.getElementById('reading-screen');
        this.settingsScreen = document.getElementById('settings-screen');

        // Input elements
        this.pasteInput = document.getElementById('paste-input');
        this.timeRemaining = document.getElementById('time-remaining');

        // Reading elements
        this.wordDisplay = document.getElementById('word-display');
        this.contextBefore = document.getElementById('context-before');
        this.anchorWord = document.getElementById('anchor-word');
        this.contextAfter = document.getElementById('context-after');
        this.readingVignette = document.getElementById('reading-vignette');
        this.pauseOverlay = document.getElementById('pause-overlay');
        this.pauseIndicator = document.getElementById('pause-indicator');
        this.pauseWpmValue = document.getElementById('pause-wpm-value');
        this.markersList = document.getElementById('markers-list');
        this.wpmDisplay = document.getElementById('wpm-display');
        this.helpCard = document.getElementById('help-card');

        // Settings elements
        this.settingsIcon = document.getElementById('settings-icon');
        this.settingsClose = document.getElementById('settings-close');

        // Completion elements
        this.completionBanner = document.getElementById('completion-banner');
        this.totalWordsEl = document.getElementById('total-words');
        this.totalTimeEl = document.getElementById('total-time');
        this.avgWpmEl = document.getElementById('avg-wpm');
        this.markersCountEl = document.getElementById('markers-count');
        this.completionMarkersList = document.getElementById('completion-markers-list');
    }

    setupEventListeners() {
        // Input handlers - auto-focus and listen for paste
        if (this.pasteInput) {
            // Auto-focus the input when page loads
            this.pasteInput.focus();

            // Listen for paste events
            this.pasteInput.addEventListener('paste', (e) => {
                e.preventDefault();
                const text = e.clipboardData.getData('text/plain');
                if (text && text.trim().length > 0) {
                    // Start reading immediately with pasted text
                    this.startReading(text);
                }
            });

            // Also handle direct input/typing (for manual entry)
            this.pasteInput.addEventListener('input', (e) => {
                const text = this.pasteInput.textContent || this.pasteInput.innerText;
                if (text && text.trim().length > 50) { // At least 50 chars before auto-starting
                    this.startReading(text);
                }
            });
        }

        // Keyboard controls
        document.addEventListener('keydown', (e) => this.handleKeyPress(e));
        document.addEventListener('keyup', (e) => this.handleKeyUp(e));

        // Settings handlers
        this.settingsIcon.addEventListener('click', () => this.toggleSettings());
        this.settingsClose.addEventListener('click', () => this.hideSettings());

        // Theme buttons
        document.querySelectorAll('[data-theme]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.settings.theme = e.target.dataset.theme;
                this.applyTheme();
                this.updateSettingButtons(e.target.parentElement, e.target);
            });
        });

        // Bracket removal toggle
        document.querySelectorAll('[data-brackets]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.settings.removeBrackets = e.target.dataset.brackets === 'true';
                this.updateSettingButtons(e.target.parentElement, e.target);
                this.saveSettings();
            });
        });

        // Adaptive timing toggle
        document.querySelectorAll('[data-adaptive]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.settings.adaptiveTiming = e.target.dataset.adaptive === 'true';
                this.updateSettingButtons(e.target.parentElement, e.target);
                this.saveSettings();
            });
        });

        // Sentence pause toggle
        document.querySelectorAll('[data-sentence-pause]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.settings.sentencePause = e.target.dataset.sentencePause === 'true';
                this.updateSettingButtons(e.target.parentElement, e.target);
                this.saveSettings();
            });
        });

        // Bionic reading toggle
        document.querySelectorAll('[data-bionic]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.settings.bionicReading = e.target.dataset.bionic === 'true';
                this.updateSettingButtons(e.target.parentElement, e.target);
                this.saveSettings();
            });
        });

        // Base WPM slider
        const baseWpmSlider = document.getElementById('base-wpm');
        const baseWpmValue = document.getElementById('base-wpm-value');
        baseWpmSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (!isNaN(value)) {
                this.settings.baseWPM = this.clamp(value, 250, 1200);
                baseWpmValue.textContent = this.settings.baseWPM;
                this.saveSettings();
            }
        });

        // Font size slider
        const fontSizeSlider = document.getElementById('font-size');
        const fontSizeValue = document.getElementById('font-size-value');
        fontSizeSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (!isNaN(value)) {
                this.settings.fontSize = this.clamp(value, 16, 96);
                fontSizeValue.textContent = `${this.settings.fontSize}px`;
                this.applyFontSize();
                this.saveSettings();
            }
        });

        // Context words slider
        const contextWordsSlider = document.getElementById('context-words');
        const contextWordsValue = document.getElementById('context-words-value');
        contextWordsSlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (!isNaN(value)) {
                this.settings.contextWords = this.clamp(value, 0, 5);
                contextWordsValue.textContent = this.settings.contextWords;
                this.saveSettings();
            }
        });

        // Thock volume slider
        const thockVolumeSlider = document.getElementById('thock-volume');
        const thockVolumeValue = document.getElementById('thock-volume-value');
        if (thockVolumeSlider && thockVolumeValue) {
            thockVolumeSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                if (!isNaN(value)) {
                    this.settings.thockVolume = this.clamp(value, 0, 1);
                    thockVolumeValue.textContent = Math.round(this.settings.thockVolume * 100) + '%';
                    this.saveSettings();
                    // Play preview sound
                    this.playThockSound();
                }
            });
        }
    }

    updateSettingButtons(container, targetButton) {
        container.querySelectorAll('.setting-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        targetButton.classList.add('active');
    }

    preprocessText(rawText) {
        // Validate input
        if (!rawText || typeof rawText !== 'string') {
            return '';
        }

        let text = rawText;

        // Normalize line breaks
        text = text.replace(/\r\n/g, '\n');

        // Remove brackets and their contents if enabled
        if (this.settings.removeBrackets) {
            // Prevent ReDoS: limit iterations to prevent infinite loops
            const MAX_ITERATIONS = 100;
            let iterations = 0;

            // Remove parentheses and content (including nested)
            while (text.match(/\([^()]*\)/) && iterations < MAX_ITERATIONS) {
                text = text.replace(/\([^()]*\)/g, '');
                iterations++;
            }

            iterations = 0;
            // Remove square brackets and content (including nested)
            while (text.match(/\[[^\[\]]*\]/) && iterations < MAX_ITERATIONS) {
                text = text.replace(/\[[^\[\]]*\]/g, '');
                iterations++;
            }

            iterations = 0;
            // Remove curly braces and content (including nested)
            while (text.match(/\{[^{}]*\}/) && iterations < MAX_ITERATIONS) {
                text = text.replace(/\{[^{}]*\}/g, '');
                iterations++;
            }

            // Clean up any double spaces left behind
            text = text.replace(/\s+/g, ' ');
        }

        // Fix broken line wraps (word-hyphen-newline-word -> word)
        text = text.replace(/(\w+)-\n(\w+)/g, '$1$2');

        // Remove stray hyphens at line ends without proper words
        text = text.replace(/-\n/g, ' ');

        // Normalize quotes
        text = text.replace(/[""]/g, '"');
        text = text.replace(/['']/g, "'");

        // Normalize multiple spaces to single space
        text = text.replace(/ +/g, ' ');

        // Preserve paragraph breaks (2+ newlines) but normalize them
        text = text.replace(/\n\n+/g, '\n\n');

        // Remove single line breaks within paragraphs
        text = text.replace(/([^\n])\n([^\n])/g, '$1 $2');

        // Clean up any remaining artifacts
        text = text.trim();

        return text;
    }

    parseIntoParagraphs(text) {
        // Split by double newlines to preserve paragraph structure
        const paragraphs = text.split('\n\n')
            .map(p => p.trim())
            .filter(p => p.length > 0);

        this.paragraphs = paragraphs;

        // Flatten into phrases with paragraph markers
        const allPhrases = [];
        paragraphs.forEach((para, paraIndex) => {
            const words = para.split(/\s+/).filter(w => w.length > 0);
            const phrases = this.createPhrases(words, paraIndex);
            allPhrases.push(...phrases);
        });

        return allPhrases;
    }

    createPhrases(words, paraIndex) {
        const phrases = [];
        let i = 0;

        while (i < words.length) {
            const phrase = this.getNextPhrase(words, i);
            const phraseWords = words.slice(i, i + phrase.wordCount);

            // Merge punctuation with preceding words
            const mergedWords = [];
            for (let j = 0; j < phraseWords.length; j++) {
                const word = phraseWords[j];
                // If this word is just punctuation and we have a previous word, merge it
                if (/^[.,!?;:]+$/.test(word) && mergedWords.length > 0) {
                    mergedWords[mergedWords.length - 1] += word;
                } else {
                    mergedWords.push(word);
                }
            }

            // Simple center word selection
            const centerIndex = Math.floor(mergedWords.length / 2);

            phrases.push({
                text: mergedWords.join(' '),
                wordCount: mergedWords.length,
                words: mergedWords, // Store individual words (with punctuation merged)
                centerIndex: centerIndex, // Which word is the focus
                paragraph: paraIndex,
                isFirst: i === 0,
                isLast: i + phrase.wordCount >= words.length,
                hasPunctuation: /[.!?;:]$/.test(mergedWords[mergedWords.length - 1])
            });

            i += phrase.wordCount;
        }

        return phrases;
    }

    getNextPhrase(words, startIndex) {
        const wordsRemaining = words.length - startIndex;
        if (wordsRemaining === 0) return { wordCount: 0 };

        // If adaptive timing is OFF, always use fixed 3-word chunks
        if (!this.settings.adaptiveTiming) {
            return { wordCount: Math.min(3, wordsRemaining) };
        }

        // Adaptive timing ON: Analyze the next few words to determine optimal chunk size
        let wordCount = 1;
        const maxChunkSize = Math.min(5, wordsRemaining);

        // Check for natural breaking points
        for (let i = 0; i < maxChunkSize; i++) {
            const word = words[startIndex + i];
            const wordLength = word.replace(/[.,!?;:'"()]+$/g, '').length;

            // Always include at least one word
            if (i === 0) {
                wordCount = 1;
            }
            // Stop at strong punctuation (period, exclamation, question)
            else if (/[.!?]$/.test(words[startIndex + i - 1])) {
                break;
            }
            // Stop at weaker punctuation if chunk is getting long
            else if (i >= 2 && /[,;:]$/.test(words[startIndex + i - 1])) {
                break;
            }
            // Stop if we have very long words (don't overload)
            else if (i >= 1 && wordLength > 10) {
                break;
            }
            // Otherwise, keep adding words up to max chunk size
            else if (i < maxChunkSize) {
                wordCount = i + 1;
            }
        }

        return { wordCount: Math.min(wordCount, wordsRemaining) };
    }

    // Apply bionic reading style: bold the first few letters of a word
    applyBionicStyle(word) {
        if (!word || word.length === 0) return '';

        // Remove punctuation for calculation
        const cleanWord = word.replace(/[.,!?;:'"()]+$/, '');
        const punctuation = word.slice(cleanWord.length);

        if (cleanWord.length === 0) return this.sanitizeText(word);

        // Calculate how many letters to bold based on word length
        let boldCount;
        if (cleanWord.length <= 2) {
            boldCount = 1;
        } else if (cleanWord.length <= 5) {
            boldCount = Math.ceil(cleanWord.length / 2);
        } else {
            boldCount = Math.ceil(cleanWord.length * 0.4);
        }

        const boldPart = this.sanitizeText(cleanWord.slice(0, boldCount));
        const normalPart = this.sanitizeText(cleanWord.slice(boldCount));
        const safePunctuation = this.sanitizeText(punctuation);

        // Use heavier font-weight and opacity contrast for better visibility
        return `<strong style="font-weight: 900;">${boldPart}</strong><span style="font-weight: 400; opacity: 0.7;">${normalPart}${safePunctuation}</span>`;
    }

    // Style a word based on current settings
    styleWord(word, isCenter = false) {
        if (!word || word.length === 0) return '';

        // If bionic reading is enabled, apply it
        if (this.settings.bionicReading) {
            return this.applyBionicStyle(word);
        }

        // Default: sanitize and return
        return this.sanitizeText(word);
    }

    // Style an array of words
    styleWords(words, isCenter = false) {
        if (!words || words.length === 0) return '';
        return words.map(w => this.styleWord(w, isCenter)).join(' ');
    }

    // Play aesthetic thock sound using Web Audio API
    playThockSound() {
        // Skip if volume is 0
        if (this.settings.thockVolume <= 0) return;

        try {
            // Create audio context if it doesn't exist
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            const ctx = this.audioContext;
            const now = ctx.currentTime;

            // Create oscillator for the "thock" sound
            const osc = ctx.createOscillator();
            const gainNode = ctx.createGain();
            const filterNode = ctx.createBiquadFilter();

            // Configure filter for a warmer, more mechanical sound
            filterNode.type = 'lowpass';
            filterNode.frequency.setValueAtTime(800, now);
            filterNode.Q.setValueAtTime(1, now);

            // Frequency envelope: sharp drop for "thock" character
            osc.frequency.setValueAtTime(150, now);
            osc.frequency.exponentialRampToValueAtTime(80, now + 0.01);
            osc.frequency.exponentialRampToValueAtTime(60, now + 0.04);

            // Gain envelope: quick attack, medium decay for satisfying sound
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(this.settings.thockVolume * 3.5, now + 0.005);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

            // Connect nodes: osc -> filter -> gain -> destination
            osc.connect(filterNode);
            filterNode.connect(gainNode);
            gainNode.connect(ctx.destination);

            // Play and cleanup
            osc.start(now);
            osc.stop(now + 0.1);

            // Clean up after sound finishes
            osc.onended = () => {
                osc.disconnect();
                filterNode.disconnect();
                gainNode.disconnect();
            };
        } catch (err) {
            // Silently fail if audio context fails
            console.debug('Audio playback unavailable:', err);
        }
    }

    async startReading(inputText = '') {
        try {
            // Validate input content
            if (!inputText || typeof inputText !== 'string' || inputText.trim().length === 0) {
                alert('No text provided to read.');
                return;
            }

            // Check for excessively long input (prevent DoS)
            const MAX_LENGTH = 10000000; // 10MB of text
            if (inputText.length > MAX_LENGTH) {
                alert(`Text is too long (${(inputText.length / 1000000).toFixed(1)}MB). Maximum supported length is 10MB.`);
                return;
            }

            this.text = this.preprocessText(inputText);
            if (!this.text || this.text.trim().length === 0) {
                alert('No valid text found after processing.');
                return;
            }

            this.words = this.parseIntoParagraphs(this.text);
            if (!this.words || this.words.length === 0) {
                alert('No words to read. Please make sure your text contains readable content.');
                return;
            }

            this.currentIndex = 0;
            this.currentParagraph = 0;
            this.currentWPM = this.clamp(this.settings.baseWPM, 250, 1200);
            this.markers = [];
            this.startTime = Date.now();
            this.totalReadingTime = 0;

            // Hide completion banner when starting new read
            if (this.completionBanner) {
                this.completionBanner.classList.remove('visible');
                this.completionBanner.classList.add('hidden');
            }

            this.showScreen('reading');
            this.isPlaying = true;
            this.isPaused = false;
            if (this.readingVignette) {
                this.readingVignette.classList.add('active');
            }
            this.playNextWord();
        } catch (err) {
            console.error('Failed to start reading:', err);
            alert('Failed to start reading. Please try again.');
        }
    }

    playNextWord() {
        if (!this.isPlaying || this.isPaused) return;

        // Validate words array exists
        if (!this.words || !Array.isArray(this.words) || this.words.length === 0) {
            console.error('No words array available');
            this.finishReading();
            return;
        }

        if (this.currentIndex >= this.words.length) {
            this.finishReading();
            return;
        }

        const phrase = this.words[this.currentIndex];

        // Validate phrase structure
        if (!phrase || !phrase.words || !Array.isArray(phrase.words) || phrase.words.length === 0) {
            console.warn('Invalid phrase at index', this.currentIndex);
            this.currentIndex++;
            this.playNextWord();
            return;
        }

        // Validate centerIndex
        const centerIndex = Math.min(phrase.centerIndex || 0, phrase.words.length - 1);

        // Split the phrase into before/center/after based on centerIndex
        const beforeWords = phrase.words.slice(0, centerIndex);
        const centerWord = phrase.words[centerIndex] || '';
        const afterWords = phrase.words.slice(centerIndex + 1);

        // FIX #1: Context Words Expansion
        // The issue was that phrases only contain 3 words max, so even with contextWords > 1,
        // we only had 1 word before/after. Solution: pull additional context from adjacent phrases.
        const contextCount = Math.max(0, Math.floor(this.settings.contextWords || 0));

        // Gather additional context from previous and next phrases if needed
        let extendedBeforeWords = [...beforeWords];
        let extendedAfterWords = [...afterWords];

        if (contextCount > beforeWords.length || contextCount > afterWords.length) {
            // Need to pull words from adjacent phrases
            const wordsNeededBefore = contextCount - beforeWords.length;
            const wordsNeededAfter = contextCount - afterWords.length;

            // Get words from previous phrase(s)
            if (wordsNeededBefore > 0 && this.currentIndex > 0) {
                for (let i = this.currentIndex - 1; i >= 0 && extendedBeforeWords.length < contextCount; i--) {
                    const prevPhrase = this.words[i];
                    if (prevPhrase && prevPhrase.words && Array.isArray(prevPhrase.words)) {
                        // Add words from previous phrase (in reverse order, then we'll reverse the whole array)
                        const prevWords = [...prevPhrase.words];
                        extendedBeforeWords = [...prevWords, ...extendedBeforeWords];
                    }
                }
            }

            // Get words from next phrase(s)
            if (wordsNeededAfter > 0 && this.currentIndex < this.words.length - 1) {
                for (let i = this.currentIndex + 1; i < this.words.length && extendedAfterWords.length < contextCount; i++) {
                    const nextPhrase = this.words[i];
                    if (nextPhrase && nextPhrase.words && Array.isArray(nextPhrase.words)) {
                        // Add words from next phrase
                        extendedAfterWords = [...extendedAfterWords, ...nextPhrase.words];
                    }
                }
            }
        }

        // Slice arrays to show only the requested number of context words
        // For beforeWords: take the LAST N words (closest to center)
        // For afterWords: take the FIRST N words (closest to center)
        const displayBefore = contextCount > 0 ? extendedBeforeWords.slice(-contextCount) : [];
        const displayAfter = contextCount > 0 ? extendedAfterWords.slice(0, contextCount) : [];

        // Check if any styling is enabled
        const stylingEnabled = this.settings.bionicReading;

        // Update display - render as single text line with spaces (with null checks)
        if (this.contextBefore) {
            if (stylingEnabled) {
                const styledBefore = this.styleWords(displayBefore);
                this.contextBefore.innerHTML = styledBefore.length > 0 ? styledBefore + ' ' : '';
            } else {
                this.contextBefore.textContent = displayBefore.length > 0 ? displayBefore.join(' ') + ' ' : '';
            }
        }
        if (this.anchorWord) {
            if (stylingEnabled) {
                this.anchorWord.innerHTML = this.styleWord(centerWord, true);
            } else {
                this.anchorWord.textContent = centerWord;
            }
        }
        if (this.contextAfter) {
            if (stylingEnabled) {
                const styledAfter = this.styleWords(displayAfter);
                this.contextAfter.innerHTML = styledAfter.length > 0 ? ' ' + styledAfter : '';
            } else {
                this.contextAfter.textContent = displayAfter.length > 0 ? ' ' + displayAfter.join(' ') : '';
            }
        }

        // Center the entire chunk at the midline
        if (this.wordDisplay) {
            requestAnimationFrame(() => {
                // Simple centering - position container at screen center with horizontal scaling
                if (this.wordDisplay) {
                    this.wordDisplay.style.left = '50%';
                    this.wordDisplay.style.transform = 'translate(-50%, -50%) scaleX(0.7)';
                }
            });
        }

        // Update paragraph tracking
        if (typeof phrase.paragraph === 'number' && phrase.paragraph !== this.currentParagraph) {
            this.currentParagraph = phrase.paragraph;
        }

        // Play thock sound
        this.playThockSound();

        // Update WPM display
        this.updateWPMDisplay();

        // Update time remaining
        this.updateTimeRemaining();

        // Calculate delay based on TOTAL VISIBLE WORDS ON SCREEN
        // This includes context words before + anchor word + context words after
        const totalVisibleWords = displayBefore.length + 1 + displayAfter.length;
        const delay = this.calculateDelay(phrase, totalVisibleWords);

        this.currentIndex++;
        this.lastWordTime = Date.now();
        this.nextWordTimeout = setTimeout(() => this.playNextWord(), delay);
    }

    calculateDelay(phrase, totalVisibleWords) {
        // Validate phrase object
        if (!phrase || typeof phrase !== 'object') {
            return 1000; // Default 1 second fallback
        }

        // Use the TOTAL VISIBLE WORDS on screen (context + anchor)
        // This ensures timing scales with how many words the user actually sees
        const wordCount = Math.max(1, Math.floor(totalVisibleWords || phrase.wordCount || 1));

        // Determine effective WPM (with rev boost if active)
        const effectiveWPM = this.isRevActive
            ? this.clamp(this.currentWPM + 100, 100, 2000)
            : this.clamp(this.currentWPM, 100, 2000);

        // Calculate delay: (words / WPM) * 60000 milliseconds
        // This ensures more words = longer display time at the same WPM
        let delay = (wordCount / effectiveWPM) * 60000;

        // Apply sentence pause multiplier if enabled
        if (this.settings.sentencePause && phrase.hasPunctuation) {
            delay = delay * 1.5;
            console.log(`[TIMING] Sentence pause applied: ${Math.round(delay/1.5)}ms -> ${Math.round(delay)}ms`);
        }

        console.log(`[TIMING] TOTAL VISIBLE WORDS=${wordCount}, WPM=${effectiveWPM}, delay=${Math.round(delay)}ms, phrase="${phrase.text}"`);

        // Return with minimum bound of 100ms
        return Math.max(100, delay);
    }

    togglePause() {
        if (!this.isPlaying) return;

        this.isPaused = !this.isPaused;

        if (this.isPaused) {
            clearTimeout(this.nextWordTimeout);
            this.readingVignette.classList.remove('active');
            this.pauseWpmValue.textContent = Math.round(this.currentWPM);
            this.pauseOverlay.classList.add('active');
            this.pauseIndicator.classList.add('visible');
            this.updateMarkersList();
        } else {
            this.readingVignette.classList.add('active');
            this.pauseOverlay.classList.remove('active');
            this.pauseIndicator.classList.remove('visible');
            this.playNextWord();
        }
    }

    adjustSpeed(delta) {
        const oldWPM = this.currentWPM;
        this.currentWPM = Math.max(
            this.settings.minWPM,
            Math.min(this.settings.maxWPM, this.currentWPM + delta)
        );

        // Update WPM display immediately
        this.updateWPMDisplay();

        // Show visual feedback if speed actually changed
        if (this.currentWPM !== oldWPM) {
            this.showSpeedFeedback(delta > 0);
        }
    }

    skipForward() {
        if (!this.isPlaying || !this.words || this.words.length === 0) return;

        const skipAmount = Math.min(10, this.words.length - this.currentIndex - 1);
        this.currentIndex = Math.min(this.currentIndex + skipAmount, this.words.length - 1);

        // Safe array access with bounds check
        if (this.currentIndex >= 0 && this.currentIndex < this.words.length) {
            this.currentParagraph = this.words[this.currentIndex].paragraph || 0;
        }

        this.showSkipFeedback(true);
    }

    skipBackward() {
        if (!this.isPlaying || !this.words || this.words.length === 0) return;

        const skipAmount = 10;
        this.currentIndex = Math.max(this.currentIndex - skipAmount, 0);

        // Safe array access with bounds check
        if (this.currentIndex >= 0 && this.currentIndex < this.words.length) {
            this.currentParagraph = this.words[this.currentIndex].paragraph || 0;
        }

        this.showSkipFeedback(false);
    }

    extractSentencesForMarker(phraseIndex, markerText) {
        // Get the phrase to find which paragraph it belongs to
        if (phraseIndex < 0 || phraseIndex >= this.words.length) return null;

        const phrase = this.words[phraseIndex];
        const paragraphIndex = phrase.paragraph || 0;

        // Get the full paragraph text
        if (paragraphIndex < 0 || paragraphIndex >= this.paragraphs.length) return null;
        const paragraphText = this.paragraphs[paragraphIndex];

        // Split paragraph into sentences using sentence boundaries
        // Match . ! ? followed by space or end of string
        const sentenceRegex = /[^.!?]+[.!?]+/g;
        const sentences = paragraphText.match(sentenceRegex) || [paragraphText];

        // Clean up sentences (trim whitespace)
        const cleanSentences = sentences.map(s => s.trim()).filter(s => s.length > 0);

        // Find which sentence(s) contain the marker text
        const markerWords = markerText.toLowerCase().split(/\s+/);
        const matchingSentences = [];

        for (const sentence of cleanSentences) {
            const sentenceLower = sentence.toLowerCase();
            // Check if any significant portion of the marker is in this sentence
            const hasMatch = markerWords.some(word => {
                // Skip very short words (like "a", "the", etc.)
                if (word.length <= 2) return false;
                return sentenceLower.includes(word);
            });

            if (hasMatch) {
                matchingSentences.push(sentence);
            }
        }

        // If we found matching sentences, return them joined
        if (matchingSentences.length > 0) {
            return matchingSentences.join(' ');
        }

        // Fallback: return the first sentence of the paragraph
        return cleanSentences[0] || paragraphText;
    }

    addMarker() {
        if (!this.isPlaying || !this.words || this.words.length === 0) return;

        // Validate indices before array access
        const currentIndex = this.currentIndex;
        const previousIndex = this.currentIndex - 1;

        // Mark both current and previous chunks
        const currentPhrase = (currentIndex >= 0 && currentIndex < this.words.length)
            ? this.words[currentIndex]
            : null;
        const previousPhrase = (previousIndex >= 0 && previousIndex < this.words.length)
            ? this.words[previousIndex]
            : null;

        if (!currentPhrase && !previousPhrase) return;

        // Combine both phrases into the snippet
        const phrases = [];
        if (previousPhrase && previousPhrase.text) phrases.push(previousPhrase.text);
        if (currentPhrase && currentPhrase.text) phrases.push(currentPhrase.text);

        if (phrases.length === 0) return;

        const snippet = phrases.join(' ');
        const index = previousPhrase ? previousIndex : currentIndex;
        const paragraph = (previousPhrase || currentPhrase).paragraph || 0;

        // Check for duplicate markers (same snippet)
        const isDuplicate = this.markers.some(m => m.snippet === snippet);
        if (isDuplicate) {
            return; // Don't add duplicate
        }

        // Extract full sentence(s) containing this marker
        const fullSentences = this.extractSentencesForMarker(index, snippet);

        this.markers.push({
            index: index,
            snippet: snippet,
            fullSentences: fullSentences || snippet, // Store full sentences
            paragraph: paragraph,
            bothChunks: true
        });
    }

    highlightSnippetInSentence(fullSentence, snippet) {
        // Escape special regex characters in snippet
        const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Create a case-insensitive regex to find the snippet
        const snippetRegex = new RegExp(`(${escapeRegex(snippet)})`, 'gi');

        // Replace the snippet with highlighted version
        return fullSentence.replace(snippetRegex, '<mark class="marker-highlight">$1</mark>');
    }

    updateMarkersList() {
        // Clear existing content
        this.markersList.innerHTML = '';

        if (this.markers.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.style.textAlign = 'center';
            emptyDiv.style.color = 'var(--accent)';
            emptyDiv.textContent = 'No markers yet. Press m to add.';
            this.markersList.appendChild(emptyDiv);
            return;
        }

        // Create marker elements with highlighted sentences
        this.markers.forEach((marker, i) => {
            const markerDiv = document.createElement('div');
            markerDiv.className = 'marker-item';
            markerDiv.dataset.index = String(marker.index);

            const strong = document.createElement('strong');
            strong.textContent = `Marker ${i + 1}`;
            markerDiv.appendChild(strong);

            markerDiv.appendChild(document.createElement('br'));

            // Display full sentence(s) with the marker highlighted
            const fullText = marker.fullSentences || marker.snippet;
            const highlightedText = this.highlightSnippetInSentence(fullText, marker.snippet);

            // Create a container for the highlighted text
            const textContainer = document.createElement('div');
            textContainer.className = 'marker-text';
            textContainer.innerHTML = highlightedText;
            markerDiv.appendChild(textContainer);

            // Make markers clickable
            markerDiv.addEventListener('click', () => {
                const index = parseInt(markerDiv.dataset.index, 10);
                if (!isNaN(index)) {
                    this.jumpToIndex(index);
                    this.togglePause();
                }
            });

            this.markersList.appendChild(markerDiv);
        });
    }

    updateCompletionMarkersList() {
        // Clear existing content
        this.completionMarkersList.innerHTML = '';

        if (this.markers.length === 0) {
            return;
        }

        // Create marker elements with highlighted sentences
        this.markers.forEach((marker, i) => {
            const markerDiv = document.createElement('div');
            markerDiv.className = 'marker-item';
            markerDiv.dataset.index = String(marker.index);

            const strong = document.createElement('strong');
            strong.textContent = `Marker ${i + 1}`;
            markerDiv.appendChild(strong);

            markerDiv.appendChild(document.createElement('br'));

            // Display full sentence(s) with the marker highlighted
            const fullText = marker.fullSentences || marker.snippet;
            const highlightedText = this.highlightSnippetInSentence(fullText, marker.snippet);

            // Create a container for the highlighted text
            const textContainer = document.createElement('div');
            textContainer.className = 'marker-text';
            textContainer.innerHTML = highlightedText;
            markerDiv.appendChild(textContainer);

            this.completionMarkersList.appendChild(markerDiv);
        });
    }

    jumpToIndex(index) {
        if (index >= 0 && index < this.words.length) {
            this.currentIndex = index;
            this.currentParagraph = this.words[index].paragraph;
        }
    }

    updateTimeRemaining() {
        if (!this.isPlaying || this.currentIndex >= this.words.length) {
            this.timeRemaining.textContent = '';
            return;
        }

        // Optimized: Use simple estimation instead of recalculating every delay
        // Calculate average delay for remaining words
        const remainingWords = this.words.length - this.currentIndex;

        // Estimate based on current WPM and average word count
        const avgWordsPerPhrase = this.words.slice(this.currentIndex, Math.min(this.currentIndex + 20, this.words.length))
            .reduce((sum, p) => sum + (p.wordCount || 1), 0) / Math.min(20, remainingWords);

        const estimatedSeconds = (remainingWords * avgWordsPerPhrase * 60) / this.currentWPM;

        // Convert to minutes and seconds
        const totalSeconds = Math.max(0, Math.ceil(estimatedSeconds));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes > 0) {
            this.timeRemaining.textContent = `${minutes}m ${seconds}s`;
        } else {
            this.timeRemaining.textContent = `${seconds}s`;
        }
    }

    finishReading() {
        this.isPlaying = false;
        clearTimeout(this.nextWordTimeout);
        this.readingVignette.classList.remove('active');
        this.totalReadingTime = Date.now() - this.startTime;

        setTimeout(() => {
            this.showCompletionScreen();
        }, 500);
    }

    showCompletionScreen() {
        // Calculate statistics
        const totalWords = this.words.reduce((sum, phrase) => sum + phrase.wordCount, 0);
        const timeInMinutes = this.totalReadingTime / 60000;

        // Prevent division by zero - minimum 1 second reading time
        const safeTimeInMinutes = Math.max(timeInMinutes, 1/60);
        const avgWPM = Math.round(totalWords / safeTimeInMinutes);

        // Format time
        const minutes = Math.floor(this.totalReadingTime / 60000);
        const seconds = Math.floor((this.totalReadingTime % 60000) / 1000);
        const timeString = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

        // Update banner UI with safe values
        this.totalWordsEl.textContent = totalWords.toLocaleString();
        this.totalTimeEl.textContent = timeString;
        this.avgWpmEl.textContent = isFinite(avgWPM) ? avgWPM.toLocaleString() : '0';
        this.markersCountEl.textContent = this.markers.length;

        // Display markers in the completion banner
        this.updateCompletionMarkersList();

        // Return to input screen
        this.showScreen('input');

        // Show completion banner (no auto-dismiss - persists until next read)
        this.completionBanner.classList.remove('hidden');
        // Use setTimeout to trigger transition
        setTimeout(() => {
            this.completionBanner.classList.add('visible');
        }, 10);
    }

    restartReading() {
        this.currentIndex = 0;
        this.currentParagraph = 0;
        this.currentWPM = this.settings.baseWPM;
        this.startTime = Date.now();
        this.totalReadingTime = 0;

        this.showScreen('reading');
        this.isPlaying = true;
        this.isPaused = false;
        this.readingVignette.classList.add('active');
        this.playNextWord();
    }

    exitReading() {
        this.isPlaying = false;
        this.isPaused = false;
        clearTimeout(this.nextWordTimeout);
        this.readingVignette.classList.remove('active');
        this.showScreen('input');
        this.pauseOverlay.classList.remove('active');
        this.hideHelpCard();
    }

    showHelpCard() {
        if (!this.isPlaying) return;
        // Auto-pause when help opens
        if (!this.isPaused) {
            this.togglePause();
        }
        this.helpCard.classList.remove('hidden');
        this.helpCard.classList.add('active');
    }

    hideHelpCard() {
        this.helpCard.classList.remove('active');
        setTimeout(() => {
            this.helpCard.classList.add('hidden');
        }, 200);
    }

    showMarkerFeedback() {
        // Create flash element if it doesn't exist
        let flash = document.querySelector('.marker-flash');
        if (!flash) {
            flash = document.createElement('div');
            flash.className = 'marker-flash';
            flash.textContent = 'Marked';
            document.body.appendChild(flash);
        }

        // Remove and re-add to restart animation
        flash.remove();
        flash = document.createElement('div');
        flash.className = 'marker-flash';
        flash.textContent = 'Marked';
        document.body.appendChild(flash);

        // Auto-remove after animation
        setTimeout(() => {
            flash.remove();
        }, 600);
    }

    showSpeedFeedback(isFaster) {
        const wpmDisplay = document.getElementById('wpm-display');
        if (!wpmDisplay) return;

        // Remove existing animation classes
        wpmDisplay.classList.remove('speed-faster', 'speed-slower');

        // Force reflow to restart animation
        void wpmDisplay.offsetWidth;

        // Add appropriate animation class
        wpmDisplay.classList.add(isFaster ? 'speed-faster' : 'speed-slower');

        // Remove class after animation completes
        setTimeout(() => {
            wpmDisplay.classList.remove('speed-faster', 'speed-slower');
        }, 500);
    }

    showSkipFeedback(isForward) {
        const skipIndicator = document.getElementById('skip-indicator');
        if (!skipIndicator) return;

        // Set the arrow direction
        skipIndicator.textContent = isForward ? '→' : '←';

        // Remove existing animation classes
        skipIndicator.classList.remove('skip-forward', 'skip-backward');

        // Force reflow to restart animation
        void skipIndicator.offsetWidth;

        // Add appropriate animation class
        skipIndicator.classList.add(isForward ? 'skip-forward' : 'skip-backward');

        // Remove class after animation completes
        setTimeout(() => {
            skipIndicator.classList.remove('skip-forward', 'skip-backward');
        }, 400);
    }


    handleKeyPress(e) {
        // Settings screen - ESC to close
        if (this.settingsScreen.classList.contains('active')) {
            if (e.key === 'Escape' || e.key === 's' || e.key === 'S') {
                this.hideSettings();
            }
            return;
        }

        // Global hotkey: 's' to toggle settings (works from input or reading screen)
        if (e.key === 's' || e.key === 'S') {
            e.preventDefault();
            this.toggleSettings();
            return;
        }

        // Reading screen controls
        if (this.readingScreen.classList.contains('active')) {
            switch(e.key) {
                case ' ':
                case 'Spacebar':
                    e.preventDefault();
                    this.togglePause();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.adjustSpeed(50);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    this.adjustSpeed(-50);
                    break;
                case ']':
                    e.preventDefault();
                    this.adjustSpeed(50);
                    break;
                case '[':
                    e.preventDefault();
                    this.adjustSpeed(-50);
                    break;
                case 'm':
                case 'M':
                    e.preventDefault();
                    this.addMarker();
                    this.showMarkerFeedback();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.skipForward();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    this.skipBackward();
                    break;
                case '?':
                    e.preventDefault();
                    this.showHelpCard();
                    break;
                case 'Escape':
                    if (this.helpCard && this.helpCard.classList.contains('active')) {
                        this.hideHelpCard();
                    } else {
                        this.exitReading();
                    }
                    break;
                case 'd':
                case 'D':
                    e.preventDefault();
                    this.exitReading();
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (!this.isPaused && !this.isRevActive) {
                        this.activateRev();
                    }
                    break;
            }
        }
    }

    handleKeyUp(e) {
        // Reading screen controls
        if (this.readingScreen.classList.contains('active')) {
            if (e.key === 'Enter' && this.isRevActive) {
                e.preventDefault();
                this.deactivateRev();
            }
        }
    }

    activateRev() {
        this.isRevActive = true;
        this.updateWPMDisplay();
    }

    deactivateRev() {
        this.isRevActive = false;
        this.updateWPMDisplay();
    }

    updateWPMDisplay() {
        if (this.isRevActive) {
            // Show boosted WPM in green
            const boostedWPM = this.currentWPM + 100;
            this.wpmDisplay.textContent = `${Math.round(boostedWPM)} WPM`;
            this.wpmDisplay.style.color = '#4ade80'; // green
        } else {
            // Show current WPM (not base WPM)
            this.wpmDisplay.textContent = `${Math.round(this.currentWPM)} WPM`;
            this.wpmDisplay.style.color = ''; // reset to default
        }
    }

    showScreen(screenName) {
        [this.inputScreen, this.readingScreen, this.settingsScreen].forEach(screen => {
            screen.classList.remove('active');
        });

        const screens = {
            input: this.inputScreen,
            reading: this.readingScreen,
            settings: this.settingsScreen
        };

        screens[screenName]?.classList.add('active');

        // When showing input screen, clear and focus paste input
        if (screenName === 'input' && this.pasteInput) {
            this.pasteInput.textContent = '';
            setTimeout(() => {
                this.pasteInput.focus();
            }, 100);
        }
    }

    toggleSettings() {
        if (this.settingsScreen.classList.contains('active')) {
            this.hideSettings();
        } else {
            this.showSettings();
        }
    }

    showSettings() {
        // Auto-pause if reading
        if (this.isPlaying && !this.isPaused) {
            this.togglePause();
        }
        this.showScreen('settings');
    }

    hideSettings() {
        const previousScreen = this.isPlaying ? 'reading' : 'input';
        this.showScreen(previousScreen);
    }

    applySettings() {
        this.applyTheme();
        this.applyFontSize();

        // Update UI to reflect loaded settings
        document.getElementById('base-wpm').value = this.settings.baseWPM;
        document.getElementById('base-wpm-value').textContent = this.settings.baseWPM;
        document.getElementById('font-size').value = this.settings.fontSize;
        document.getElementById('font-size-value').textContent = `${this.settings.fontSize}px`;
        document.getElementById('context-words').value = this.settings.contextWords;
        document.getElementById('context-words-value').textContent = this.settings.contextWords;

        const thockVolumeSlider = document.getElementById('thock-volume');
        const thockVolumeValue = document.getElementById('thock-volume-value');
        if (thockVolumeSlider && thockVolumeValue) {
            thockVolumeSlider.value = this.settings.thockVolume;
            thockVolumeValue.textContent = Math.round(this.settings.thockVolume * 100) + '%';
        }

        // Highlight active buttons
        document.querySelectorAll('[data-theme]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === this.settings.theme);
        });
        document.querySelectorAll('[data-brackets]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.brackets === String(this.settings.removeBrackets));
        });
        document.querySelectorAll('[data-adaptive]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.adaptive === String(this.settings.adaptiveTiming));
        });
        document.querySelectorAll('[data-sentence-pause]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.sentencePause === String(this.settings.sentencePause));
        });
        document.querySelectorAll('[data-bionic]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.bionic === String(this.settings.bionicReading));
        });
    }

    applyTheme() {
        document.body.className = `theme-${this.settings.theme}`;
        this.saveSettings();
    }

    applyFontSize() {
        document.documentElement.style.setProperty('--font-size', `${this.settings.fontSize}px`);
    }

    saveSettings() {
        try {
            localStorage.setItem('speedReaderSettings', JSON.stringify(this.settings));
        } catch (err) {
            console.warn('Failed to save settings to localStorage:', err);
            // Possible reasons: localStorage disabled, quota exceeded, private mode
        }
    }

    loadSettings() {
        try {
            const saved = localStorage.getItem('speedReaderSettings');
            if (saved) {
                const savedSettings = JSON.parse(saved);
                // Migrate old baseWPM value of 800 to new default of 350
                if (savedSettings.baseWPM === 800) {
                    savedSettings.baseWPM = 350;
                }
                // Validate and sanitize loaded settings
                this.settings = { ...this.settings, ...this.validateSettings(savedSettings) };
            }
        } catch (err) {
            console.warn('Failed to load settings from localStorage:', err);
            // Continue with default settings
        }
    }

    // Security: Sanitize text to prevent XSS
    sanitizeText(text) {
        if (typeof text !== 'string') {
            return '';
        }
        // Remove any potential HTML/script tags
        return text
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
    }

    // Validate settings object
    validateSettings(settings) {
        const validated = {};

        // Validate theme
        if (settings.theme === 'light' || settings.theme === 'dark') {
            validated.theme = settings.theme;
        }

        // Validate numeric settings with bounds
        if (typeof settings.fontSize === 'number') {
            validated.fontSize = this.clamp(settings.fontSize, 16, 96);
        }

        if (typeof settings.contextWords === 'number') {
            validated.contextWords = this.clamp(Math.floor(settings.contextWords), 0, 5);
        }

        if (typeof settings.thockVolume === 'number') {
            validated.thockVolume = this.clamp(settings.thockVolume, 0, 1);
        }

        if (typeof settings.baseWPM === 'number') {
            validated.baseWPM = this.clamp(settings.baseWPM, 250, 1200);
        }

        if (typeof settings.minWPM === 'number') {
            validated.minWPM = this.clamp(settings.minWPM, 100, 500);
        }

        if (typeof settings.maxWPM === 'number') {
            validated.maxWPM = this.clamp(settings.maxWPM, 500, 2000);
        }

        // Validate boolean settings
        if (typeof settings.removeBrackets === 'boolean') {
            validated.removeBrackets = settings.removeBrackets;
        }

        if (typeof settings.adaptiveTiming === 'boolean') {
            validated.adaptiveTiming = settings.adaptiveTiming;
        }

        if (typeof settings.sentencePause === 'boolean') {
            validated.sentencePause = settings.sentencePause;
        }

        if (typeof settings.bionicReading === 'boolean') {
            validated.bionicReading = settings.bionicReading;
        }

        return validated;
    }

    // Utility: Clamp number between min and max
    clamp(value, min, max) {
        if (isNaN(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    // Safe number parsing
    parseNumber(value, defaultValue = 0) {
        const parsed = typeof value === 'number' ? value : parseFloat(value);
        return isNaN(parsed) ? defaultValue : parsed;
    }
}

// Initialize on page load
window.addEventListener('load', () => {
    const app = new SpeedReader();
});
