#!/usr/bin/env node
// Exhaustive plural fallback test: verifies every vocab entry's plural forms
// resolve correctly and flags cross-entry collisions for review.
//
// "Collision" here means: the plural of word A is already an explicit vocab
// entry for word B. addPluralFallbacks() correctly skips these (word B wins),
// so they are informational — not failures. A failure would be a plural that
// maps to an entirely wrong entry (impossible with current logic) or is absent.

const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, 'hsk1_v3.csv');
const lines = fs.readFileSync(csvPath, 'utf8').split('\n');

// Build wordMap identical to the extension's loadVocabulary()
const wordMap = {};
for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
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

// Must stay in sync with generatePlurals() + NO_PLURAL in content.js
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

// Mirrors addPluralFallbacks() in content.js exactly
function addPluralFallbacks(map) {
  const extended = { ...map };
  for (const [word, entry] of Object.entries(map)) {
    for (const plural of generatePlurals(word)) {
      if (!extended[plural]) extended[plural] = entry;
    }
  }
  return extended;
}

const extendedMap = addPluralFallbacks(wordMap);
const singleWords = Object.entries(wordMap).filter(([w]) => !w.includes(' '));

// Phase 1: detect cross-entry collisions
// A collision is when a generated plural is already mapped to a DIFFERENT Chinese word.
// addPluralFallbacks() skips these (explicit entry wins), so these are INFO only.
const explicitCollisions = [];
for (const [word, entry] of singleWords) {
  for (const plural of generatePlurals(word)) {
    if (wordMap[plural] && wordMap[plural].chinese !== entry.chinese) {
      explicitCollisions.push({
        singular: word,
        plural,
        singularChinese: entry.chinese,
        explicitChinese: wordMap[plural].chinese,
      });
    }
  }
}

// Phase 2: verify every generated plural resolves to SOME correct entry in
// the extended map. Failures are genuine bugs.
let passed = 0;
const failures = [];

for (const [word, entry] of singleWords) {
  for (const plural of generatePlurals(word)) {
    const result = extendedMap[plural];
    if (!result) {
      // Should never happen: addPluralFallbacks adds the entry when absent
      failures.push(`MISS: "${plural}" (plural of "${word}" / ${entry.chinese}) absent from extended map`);
    } else if (result.chinese !== entry.chinese && !wordMap[plural]) {
      // Incorrect override: plural maps to wrong entry and wasn't an explicit entry
      failures.push(`WRONG MAPPING: "${plural}" (plural of "${word}" / ${entry.chinese}) maps to ${result.chinese}`);
    } else {
      passed++;
    }
  }
}

// Report
console.log('=== Plural Fallback Exhaustive Test ===');
console.log(`Vocabulary : ${Object.keys(wordMap).length} entries (${singleWords.length} single-word)`);
console.log(`Plurals    : ${passed + failures.length} tested`);
console.log(`Passed     : ${passed}`);
console.log(`Failed     : ${failures.length}`);

if (explicitCollisions.length > 0) {
  console.log('\nINFO — plural forms that are already explicit vocab entries (addPluralFallbacks skips these; explicit entry takes precedence):');
  for (const c of explicitCollisions) {
    console.log(`  "${c.plural}" is plural of "${c.singular}" (${c.singularChinese}), but "${c.plural}" itself maps to ${c.explicitChinese}`);
  }
  console.log('  These are correct: the explicit mapping wins over the generated fallback.');
}

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
  console.log(`\n✗ ${failures.length} plural fallback(s) failed`);
  process.exit(1);
} else {
  console.log('\n✓ All plural fallbacks verified successfully');
  process.exit(0);
}
