/**
 * Harness-agnostic tool catalog: JS identifier sanitization, BM25 ranking,
 * schema lookup, and Levenshtein "did you mean" recovery hints.
 */

export function sanitizeJsName(name) {
  const raw = String(name ?? "").trim();
  if (!raw) return "_tool";
  let clean = raw.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(clean)) {
    clean = "_" + clean;
  }
  return clean || "_tool";
}

export function tokenize(text) {
  const s = String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return s.match(/[a-z0-9]+/g) || [];
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Uint32Array(n + 1);
  let curr = new Uint32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

export function closestMatches(query, candidates, limit = 3) {
  const q = String(query ?? "").toLowerCase();
  if (!q || !candidates.length) return [];
  const scored = [];
  for (const cand of candidates) {
    const c = cand.toLowerCase();
    const maxLen = Math.max(q.length, c.length, 1);
    const dist = levenshtein(q, c);
    const ratio = 1 - dist / maxLen;
    if (ratio >= 0.55 || c.includes(q) || q.includes(c)) {
      scored.push({ cand, ratio, dist });
    }
  }
  scored.sort((x, y) => y.ratio - x.ratio || x.dist - y.dist || x.cand.localeCompare(y.cand));
  return scored.slice(0, limit).map((s) => s.cand);
}

export class BM25Index {
  constructor(docs, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = docs.map((d) => {
      const tokens = tokenize(d.text);
      const tf = new Map();
      for (const tok of tokens) {
        tf.set(tok, (tf.get(tok) || 0) + 1);
      }
      return { item: d.item, len: tokens.length, tf };
    });
    this.n = this.docs.length;
    this.avgLen = this.n > 0
      ? this.docs.reduce((acc, d) => acc + d.len, 0) / this.n
      : 0;
    this.df = new Map();
    for (const d of this.docs) {
      for (const tok of d.tf.keys()) {
        this.df.set(tok, (this.df.get(tok) || 0) + 1);
      }
    }
  }

  search(query, topK = 5) {
    if (this.n === 0 || this.avgLen === 0) return [];
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];
    const k = Math.max(1, Math.min(Number(topK) || 5, 50));
    const hits = [];
    for (const doc of this.docs) {
      if (doc.len === 0) continue;
      let score = 0;
      for (const tok of qTokens) {
        const freq = doc.tf.get(tok) || 0;
        if (freq === 0) continue;
        const df = this.df.get(tok) || 0;
        const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
        const denom = freq + this.k1 * (1 - this.b + this.b * (doc.len / this.avgLen));
        score += idf * ((freq * (this.k1 + 1)) / denom);
      }
      if (score > 0) {
        hits.push({ item: doc.item, score: Math.round(score * 10000) / 10000 });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return hits.slice(0, k);
  }
}

export class Catalog {
  constructor(tools = []) {
    this.entries = [];
    this.byJs = new Map();
    this.byName = new Map();
    this.jsToName = new Map();

    const used = new Set();
    for (const raw of tools) {
      if (!raw || !raw.name) continue;
      const name = String(raw.name);
      const base = sanitizeJsName(raw.js || name);
      let js = base;
      let suffix = 2;
      while (used.has(js)) {
        js = `${base}_${suffix++}`;
      }
      used.add(js);
      const entry = {
        js,
        name,
        description: String(raw.description || ""),
        schema: raw.schema && typeof raw.schema === "object" ? raw.schema : {},
      };
      this.entries.push(entry);
      this.byJs.set(js, entry);
      this.byName.set(name, entry);
      this.jsToName.set(js, name);
    }

    this._index = new BM25Index(
      this.entries.map((entry) => ({
        item: entry,
        text: `${entry.name} ${entry.js} ${entry.description}`,
      })),
    );
  }

  search(query, topK = 5) {
    return this._index.search(query, topK).map(({ item, score }) => ({
      name: item.name,
      js: item.js,
      description: item.description,
      score,
    }));
  }

  hint(name) {
    const jsKeys = Array.from(this.byJs.keys());
    const matches = closestMatches(sanitizeJsName(name), jsKeys, 3);
    if (matches.length) {
      return `unknown tool: ${name} (did you mean: ${matches.join(", ")})`;
    }
    return `unknown tool: ${name}`;
  }

  describe(name) {
    const key = String(name ?? "");
    const entry = this.byName.get(key) || this.byJs.get(key);
    if (!entry) {
      return { ok: false, error: this.hint(key) };
    }
    return {
      ok: true,
      name: entry.name,
      js: entry.js,
      description: entry.description,
      schema: entry.schema,
    };
  }

  toWire() {
    return this.entries.map((e) => ({
      js: e.js,
      name: e.name,
      description: e.description,
      schema: e.schema,
    }));
  }
}
