/**
 * Zhangchao browser extension — content script
 *
 * When enabled, replaces English words with Chinese characters as you browse.
 * Hover over any replaced word to see its pinyin and original English in a tooltip.
 * Respects a user-configurable blacklist of hostnames.
 */

(function () {
  if (window.__zhangchaoLoaded) return;
  window.__zhangchaoLoaded = true;

  // ── State ──────────────────────────────────────────────────────────────────

  let enabled = true;
  let wordMap = {};   // englishLower → { chinese, pinyin }
  let wordRegex = null;
  let vocabLoaded = false;
  let domProcessed = false;
  let domObserver = null;

  // ── Vocabulary loading ─────────────────────────────────────────────────────

  async function loadVocabulary() {
    const url = chrome.runtime.getURL('hsk1_v3.csv');
    const response = await fetch(url);
    const text = await response.text();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      // Format: chinese,pinyin,english1;english2;...
      const first  = line.indexOf(',');
      const second = line.indexOf(',', first + 1);
      if (first === -1 || second === -1) continue;
      const chinese      = line.slice(0, first).trim();
      const pinyin       = line.slice(first + 1, second).trim();
      const englishField = line.slice(second + 1).trim();
      for (const eng of englishField.split(';')) {
        const engLower = eng.trim().toLowerCase();
        if (engLower) wordMap[engLower] = { chinese, pinyin };
      }
    }
    // Add plural fallbacks for single-word entries not already in the vocab
    addPluralFallbacks();

    // Sort by length descending so longer phrases match before shorter ones
    const sorted  = Object.keys(wordMap).sort((a, b) => b.length - a.length);
    const escaped = sorted.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    wordRegex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
    vocabLoaded = true;
  }

  // Words that shouldn't generate plural fallbacks (pronouns etc. with no
  // useful plural, or whose algorithm-derived plural collides with a different
  // vocab entry).
  const NO_PLURAL = new Set(['us']);

  function generatePlurals(word) {
    if (word.includes(' ') || word.length < 2) return [];
    if (NO_PLURAL.has(word)) return [];
    if (word.endsWith('fe') && word.length > 3) return [word.slice(0, -2) + 'ves'];
    if (word.endsWith('f') && word.length > 2) return [word.slice(0, -1) + 'ves'];
    if (word.endsWith('y') && word.length > 2 && !/[aeiou]y$/.test(word)) return [word.slice(0, -1) + 'ies'];
    if (/(?:[sxz]|[cs]h)$/.test(word)) return [word + 'es'];
    return [word + 's'];
  }

  function addPluralFallbacks() {
    for (const [word, entry] of Object.entries(wordMap)) {
      for (const plural of generatePlurals(word)) {
        if (!wordMap[plural]) wordMap[plural] = entry;
      }
    }
  }

  // ── Case-sensitivity rules (mirrors the elisp logic) ──────────────────────
  // lowercase, Title-case, and single capital → replace
  // ALL-CAPS (acronyms like HTML, URL) → skip

  function shouldReplace(word) {
    if (!wordMap[word.toLowerCase()]) return false;
    if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return false;
    return true;
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────

  let tooltip = null;

  function ensureTooltip() {
    if (tooltip) return;
    tooltip = document.createElement('div');
    tooltip.id = 'zhangchao-tooltip';
    tooltip.dataset.zhangchaoUi = 'true';
    Object.assign(tooltip.style, {
      position:      'fixed',
      background:    'rgba(28, 28, 28, 0.96)',
      color:         '#f0f0f0',
      padding:       '7px 13px',
      borderRadius:  '7px',
      fontSize:      '13px',
      lineHeight:    '1.7',
      pointerEvents: 'none',
      zIndex:        '2147483647',
      display:       'none',
      boxShadow:     '0 3px 12px rgba(0,0,0,0.5)',
      fontFamily:    'system-ui, sans-serif',
      maxWidth:      '280px',
      whiteSpace:    'nowrap',
    });
    document.body.appendChild(tooltip);

    document.addEventListener('mouseover', (e) => {
      const el = e.target && e.target.closest && e.target.closest('.zhangchao-word');
      if (el) {
        const { pinyin, english, original } = el.dataset;
        tooltip.innerHTML =
          `<span style="font-size:16px;font-weight:600">${pinyin}</span>` +
          `<span style="color:#bbb;margin-left:8px">·</span>` +
          `<span style="margin-left:8px">${escapeHtml(original)}</span>` +
          (english !== original.toLowerCase()
            ? `<span style="color:#999;margin-left:4px">(${escapeHtml(english)})</span>`
            : '');
        tooltip.style.display = 'block';
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (tooltip.style.display === 'none') return;
      let x = e.clientX + 14;
      let y = e.clientY + 14;
      if (x + 290 > window.innerWidth)  x = e.clientX - 290;
      if (y + 60  > window.innerHeight) y = e.clientY - 60;
      tooltip.style.left = x + 'px';
      tooltip.style.top  = y + 'px';
    });

    document.addEventListener('mouseout', (e) => {
      if (e.target && e.target.closest && e.target.closest('.zhangchao-word')) {
        tooltip.style.display = 'none';
      }
    });
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // ── DOM processing ─────────────────────────────────────────────────────────

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'MATH', 'SVG',
  ]);

  function processSubtree(root) {
    if (!vocabLoaded) return;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          const p = n.parentNode;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
          if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (p.classList && p.classList.contains('zhangchao-word')) return NodeFilter.FILTER_REJECT;
          if (p.closest && p.closest('[data-zhangchao-ui]')) return NodeFilter.FILTER_REJECT;
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) replaceInTextNode(node);
  }

  function replaceInTextNode(node) {
    const text  = node.nodeValue;
    const regex = new RegExp(wordRegex.source, 'gi');
    const matches = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
      if (shouldReplace(m[0])) matches.push({ index: m.index, word: m[0] });
    }
    if (matches.length === 0) return;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const { index, word } of matches) {
      if (index > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, index)));
      }
      const { chinese, pinyin } = wordMap[word.toLowerCase()];
      const span = document.createElement('span');
      span.className         = 'zhangchao-word';
      span.dataset.original  = word;
      span.dataset.chinese   = chinese;
      span.dataset.pinyin    = pinyin;
      span.dataset.english   = word.toLowerCase();
      span.textContent       = chinese;
      span.style.cssText     = 'cursor:help;border-bottom:1px dotted rgba(120,120,120,0.6);';
      frag.appendChild(span);
      cursor = index + word.length;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(frag, node);
  }

  // ── Enable / disable ───────────────────────────────────────────────────────

  function enable() {
    enabled = true;
    if (!domProcessed) {
      ensureTooltip();
      processSubtree(document.body);
      startObserver();
      domProcessed = true;
    }
  }

  function disable() {
    enabled = false;
    for (const span of document.querySelectorAll('.zhangchao-word')) {
      span.replaceWith(document.createTextNode(span.dataset.original));
    }
    domProcessed = false;
  }

  // ── MutationObserver for dynamic content ──────────────────────────────────

  function startObserver() {
    if (domObserver) return;
    domObserver = new MutationObserver((mutations) => {
      if (!enabled) return;
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) processSubtree(node);
        }
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Blacklist check ────────────────────────────────────────────────────────

  async function isBlacklisted() {
    const hostname = window.location.hostname.toLowerCase();
    const result   = await chrome.storage.local.get('blacklist');
    const list     = result.blacklist || [];
    return list.some(domain => {
      const d = domain.trim().toLowerCase();
      return d && (hostname === d || hostname.endsWith('.' + d));
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  async function init() {
    if (await isBlacklisted()) return;

    await loadVocabulary();

    const result = await chrome.storage.local.get('enabled');
    // Default to enabled
    if (result.enabled !== false) enable();
  }

  // React to popup toggle in real time
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled && vocabLoaded) {
      changes.enabled.newValue !== false ? enable() : disable();
    }
  });

  init();
})();
