/**
 * Semantic search for LAIA Brain.
 * BM25 ranking with stemming and trigram fuzzy matching.
 * Zero external dependencies.
 */

import { tokenize } from "./utils.js";
import { getContentGeneration } from "./file-io.js";

// ─── Stop words (English + Catalan) ──────────────────────────────────────────

const STOP_WORDS = new Set([
  // English
  "the", "is", "at", "which", "on", "in", "to", "for", "with", "and", "or",
  "but", "not", "this", "that", "from", "by", "an", "be", "as", "are", "was",
  "were", "been", "has", "have", "had", "its", "it", "of", "if", "can", "do",
  "does", "did", "will", "would", "could", "should", "may", "might",
  "all", "each", "every", "both", "few", "more", "most", "other", "some",
  "such", "no", "nor", "too", "very", "just", "about", "also", "then",
  "than", "when", "how", "what", "where", "who", "why",
  // Catalan
  "el", "la", "els", "les", "un", "una", "uns", "unes", "de", "del", "al",
  "amb", "per", "que", "com", "més", "tot", "són", "ser", "fer", "dir",
  "és", "ha", "hem", "han", "seu", "seva", "seus", "seves", "si",
]);

export { STOP_WORDS };

// ─── Stemming (conservative suffix stripping) ────────────────────────────────

export function stem(word) {
  if (word.length < 5) return word;
  // ── Catalan rules FIRST (longer, more specific suffixes) ─────────────────
  // Derivational: -ització/-itzacions → root
  if (word.endsWith("itzacions") && word.length > 12) return word.slice(0, -9);
  if (word.endsWith("ització") && word.length > 10) return word.slice(0, -7);
  if (word.endsWith("itzades") && word.length > 10) return word.slice(0, -7);
  if (word.endsWith("itzada") && word.length > 9) return word.slice(0, -6);
  if (word.endsWith("itzats") && word.length > 9) return word.slice(0, -6);
  if (word.endsWith("itzat") && word.length > 8) return word.slice(0, -5);
  if (word.endsWith("itzar") && word.length > 8) return word.slice(0, -5);
  // Nominals: -cions/-ció, -sions/-sió
  if (word.endsWith("cions") && word.length > 7) return word.slice(0, -5);
  if (word.endsWith("ció") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("sions") && word.length > 7) return word.slice(0, -5);
  if (word.endsWith("sió") && word.length > 5) return word.slice(0, -3);
  // Generic: -ions/-ió (catches connexions, reflexió, etc.) — tighter guards
  if (word.endsWith("ions") && word.length > 7) return word.slice(0, -4);
  if (word.endsWith("ió") && word.length > 6) return word.slice(0, -2);
  // Nominals: -itats/-itat
  if (word.endsWith("itats") && word.length > 7) return word.slice(0, -5);
  if (word.endsWith("itat") && word.length > 6) return word.slice(0, -4);
  // Agent: -adors/-adores/-ador/-adora
  if (word.endsWith("adores") && word.length > 9) return word.slice(0, -6);
  if (word.endsWith("adors") && word.length > 8) return word.slice(0, -5);
  if (word.endsWith("adora") && word.length > 8) return word.slice(0, -5);
  if (word.endsWith("ador") && word.length > 7) return word.slice(0, -4);
  // Abstract: -ismes/-isme, -istes/-ista (ista guarded: min stem ≥ 5)
  if (word.endsWith("ismes") && word.length > 7) return word.slice(0, -5);
  if (word.endsWith("isme") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("istes") && word.length > 7) return word.slice(0, -5);
  if (word.endsWith("ista") && word.length > 8) return word.slice(0, -4);
  // Adjectival: -bles (Catalan plural; singular -able/-ible handled by English rules)
  if (word.endsWith("bles") && word.length > 6) return word.slice(0, -4);
  // Catalan nominals: -ments/-ment (before English -ment to handle plurals)
  if (word.endsWith("ments") && word.length > 7) return word.slice(0, -5);
  // -tat (broader abstract nouns)
  if (word.endsWith("tat") && word.length > 5) return word.slice(0, -3);
  // ── English rules (ordered by suffix length, longest first) ─────────────
  if (word.endsWith("ation") && word.length > 7) return word.slice(0, -5);
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("sion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ment") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ness") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("able") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ible") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ous") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ive") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ful") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ity") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ize") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ise") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("fy") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("er") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ly") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("al") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) return word.slice(0, -1);
  return word;
}

// ─── Trigrams ────────────────────────────────────────────────────────────────

export function trigrams(word) {
  if (word.length < 3) return [word];
  const t = [];
  for (let i = 0; i <= word.length - 3; i++) t.push(word.slice(i, i + 3));
  return t;
}

export function trigramSimilarity(a, b) {
  const tA = new Set(trigrams(a));
  const tB = new Set(trigrams(b));
  let intersection = 0;
  for (const t of tA) if (tB.has(t)) intersection++;
  const union = tA.size + tB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── BM25 Index ──────────────────────────────────────────────────────────────

export class BM25Index {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = [];              // [{id, length}]
    this.docIndex = new Map();   // id → docIdx
    this.invertedIndex = new Map(); // term → Map<docIdx, freq>
    this.idf = new Map();        // term → idf
    this.trigramIdx = new Map(); // trigram → Set<term>
    this.avgdl = 0;
    this.N = 0;
    this.built = false;
  }

  addDocument(id, text) {
    const tokens = typeof text === "string" ? tokenize(text) : text;
    const docIdx = this.docs.length;
    this.docIndex.set(id, docIdx);

    const termFreq = new Map();
    let effectiveLen = 0;

    for (const token of tokens) {
      if (STOP_WORDS.has(token)) continue;
      effectiveLen++;
      termFreq.set(token, (termFreq.get(token) || 0) + 1);

      // Also index stemmed variant with reduced weight
      const stemmed = stem(token);
      if (stemmed !== token && stemmed.length >= 3) {
        termFreq.set(stemmed, (termFreq.get(stemmed) || 0) + 0.5);
      }
    }

    this.docs.push({ id, length: effectiveLen });

    for (const [term, freq] of termFreq) {
      if (!this.invertedIndex.has(term)) this.invertedIndex.set(term, new Map());
      this.invertedIndex.get(term).set(docIdx, freq);

      // Build trigram index for fuzzy matching
      for (const tri of trigrams(term)) {
        if (!this.trigramIdx.has(tri)) this.trigramIdx.set(tri, new Set());
        this.trigramIdx.get(tri).add(term);
      }
    }
  }

  finalize() {
    this.N = this.docs.length;
    if (this.N === 0) { this.built = true; return; }

    this.avgdl = this.docs.reduce((sum, d) => sum + d.length, 0) / this.N;

    for (const [term, postings] of this.invertedIndex) {
      const df = postings.size;
      this.idf.set(term, Math.log((this.N - df + 0.5) / (df + 0.5) + 1));
    }

    this.built = true;
  }

  _findFuzzyCandidates(token, minSimilarity = 0.4) {
    const queryTri = trigrams(token);
    const candidates = new Map(); // term → shared trigram count
    for (const tri of queryTri) {
      const terms = this.trigramIdx.get(tri);
      if (!terms) continue;
      for (const term of terms) {
        candidates.set(term, (candidates.get(term) || 0) + 1);
      }
    }

    const results = [];
    for (const [term, sharedCount] of candidates) {
      if (sharedCount < 2 && token.length > 4) continue; // pre-filter
      const sim = trigramSimilarity(token, term);
      if (sim >= minSimilarity) results.push({ term, similarity: sim });
    }
    return results.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  }

  search(queryTokens, fuzzyThreshold = 0.4) {
    if (!this.built || this.N === 0) return new Map();

    // Expand query with stems
    const expandedTokens = [];
    for (const qt of queryTokens) {
      if (STOP_WORDS.has(qt)) continue;
      expandedTokens.push({ token: qt, weight: 1.0 });
      const stemmed = stem(qt);
      if (stemmed !== qt && stemmed.length >= 3) {
        expandedTokens.push({ token: stemmed, weight: 0.7 });
      }
    }

    const scores = new Map(); // docIdx → score

    for (const { token, weight } of expandedTokens) {
      const postings = this.invertedIndex.get(token);

      if (postings && postings.size > 0) {
        // Exact or stem match
        const idf = this.idf.get(token) || 0;
        for (const [docIdx, freq] of postings) {
          const dl = this.docs[docIdx].length;
          const tf = (freq * (this.k1 + 1)) / (freq + this.k1 * (1 - this.b + this.b * dl / this.avgdl));
          scores.set(docIdx, (scores.get(docIdx) || 0) + idf * tf * weight);
        }
      } else {
        // Fuzzy fallback via trigrams
        const fuzzyMatches = this._findFuzzyCandidates(token, fuzzyThreshold);
        for (const { term, similarity } of fuzzyMatches) {
          const idf = this.idf.get(term) || 0;
          const fPostings = this.invertedIndex.get(term);
          if (!fPostings) continue;
          for (const [docIdx, freq] of fPostings) {
            const dl = this.docs[docIdx].length;
            const tf = (freq * (this.k1 + 1)) / (freq + this.k1 * (1 - this.b + this.b * dl / this.avgdl));
            scores.set(docIdx, (scores.get(docIdx) || 0) + idf * tf * similarity * 0.6 * weight);
          }
        }
      }
    }

    // Convert docIdx → id
    const result = new Map();
    for (const [docIdx, score] of scores) {
      result.set(this.docs[docIdx].id, score);
    }
    return result;
  }
}

// ─── Global index (lazy singleton with generation tracking) ──────────────────

let _globalIndex = null;
let _indexGeneration = -1;

export function buildSemanticIndex(learnings, cachedFiles) {
  const index = new BM25Index();

  for (const l of learnings) {
    const text = [l.title, l.headline, l.body, ...(l.tags || [])].filter(Boolean).join(" ");
    index.addDocument(`learning:${l.slug}`, text);
  }

  for (const { relPath, content } of cachedFiles) {
    index.addDocument(`file:${relPath}`, content);
  }

  index.finalize();
  return index;
}

export function getOrBuildIndex(learnings, cachedFiles) {
  const gen = getContentGeneration();
  if (_globalIndex && _indexGeneration === gen) return _globalIndex;
  _globalIndex = buildSemanticIndex(learnings, cachedFiles);
  _indexGeneration = gen;
  return _globalIndex;
}

export function invalidateSemanticIndex() {
  _globalIndex = null;
  _indexGeneration = -1;
}
