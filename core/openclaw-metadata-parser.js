// OpenClawMetadataParser — PR-27. Parses `metadata.openclaw` flow-style block
// (raw string from PR-26a) into {emoji?, requires?}. Never throws, bad → null.
// Design: PR_DESIGN_26 §2 + §1.4. Unknown fields ignored (OpenClaw evolves).
const log = (m) => process?.stderr?.write?.('[openclaw-metadata-parser] ' + m + '\n');

// Walk balanced {...} or [...] from `start`; return substring or null.
function block(src, start) {
  let d = 0,
    s = null,
    e = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (s) {
      if (e) {
        e = false;
      } else if (c === '\\') {
        e = true;
      } else if (c === s) {
        s = null;
      }
    } else if (c === '"' || c === "'") {
      s = c;
    } else if (c === '{' || c === '[') {
      d++;
    } else if (c === '}' || c === ']') {
      d--;
      if (!d) {
        return src.slice(start, i + 1);
      }
    }
  }
  return null;
}

// Split on top-level commas (respects nested {} [] + quoted strings).
function split(inner) {
  const out = [];
  let d = 0,
    s = null,
    e = false,
    buf = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (s) {
      buf += c;
      if (e) {
        e = false;
      } else if (c === '\\') {
        e = true;
      } else if (c === s) {
        s = null;
      }
    } else if (c === '"' || c === "'") {
      s = c;
      buf += c;
    } else if (c === '{' || c === '[') {
      d++;
      buf += c;
    } else if (c === '}' || c === ']') {
      d--;
      buf += c;
    } else if (!d && c === ',') {
      out.push(buf);
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf) {
    out.push(buf);
  }
  return out;
}

const unq = (s) => {
  const t = s.trim();
  return t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))
    ? t.slice(1, -1)
    : t;
};
const kv = (p) => {
  const i = p.indexOf(':');
  return i < 0 ? null : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
};

// Parse `requires: { bins: [...], env: {K:V} }` inner.
function reqInner(inner) {
  const r = {};
  for (const p of split(inner)) {
    const k = kv(p);
    if (!k) {
      continue;
    }
    if (k[0] === 'bins') {
      const v = k[1];
      const a = split(v[0] === '[' && v[v.length - 1] === ']' ? v.slice(1, -1) : v)
        .map(unq)
        .filter(Boolean);
      if (a.length) {
        r.bins = a;
      }
    } else if (k[0] === 'env') {
      const e = {};
      const v = k[1];
      const in2 = v[0] === '{' && v[v.length - 1] === '}' ? v.slice(1, -1) : v;
      for (const ep of split(in2)) {
        const k2 = kv(ep);
        if (k2) {
          e[k2[0]] = unq(k2[1]);
        }
      }
      if (Object.keys(e).length) {
        r.env = e;
      }
    }
  }
  return r;
}

/**
 * Parse `metadata.openclaw` raw string → {emoji?, requires?}.
 * @param {string} raw - e.g. `{ openclaw: { emoji: '☔', requires: { bins: [curl] } } }`
 * @returns {{emoji?: string, requires?: {bins?: string[], env?: object}}|null}
 */
export function parseOpenClawMetadata(raw) {
  try {
    const blk = topBlock(raw);
    if (!blk) {
      return null;
    }
    return parseOuter(blk.slice(1, -1));
  } catch (err) {
    log('parse failed: ' + err.message);
    return null;
  }
}

function topBlock(raw) {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  const i = raw.indexOf('{');
  if (i < 0) {
    return null;
  }
  return block(raw, i);
}

function parseOuter(inner) {
  for (const p of split(inner)) {
    const k = kv(p);
    if (k && k[0] === 'openclaw') {
      return parseOcBlock(k[1]);
    }
  }
  return null;
}

function parseOcBlock(ocStr) {
  const oc = block(ocStr, ocStr.indexOf('{'));
  if (!oc) {
    return null;
  }
  return parseOcFields(oc.slice(1, -1));
}

function parseOcFields(inner) {
  const out = {};
  for (const f of split(inner)) {
    const k = kv(f);
    if (!k) {
      continue;
    }
    if (k[0] === 'emoji') {
      const e = unq(k[1]);
      if (e) {
        out.emoji = e;
      }
    } else if (k[0] === 'requires') {
      out.requires = parseRequiresBlock(k[1]);
    }
  }
  return Object.keys(out).length ? out : null;
}

function parseRequiresBlock(reqStr) {
  const rb = block(reqStr, reqStr.indexOf('{'));
  if (!rb) {
    return null;
  }
  const r = reqInner(rb.slice(1, -1));
  return Object.keys(r).length ? r : null;
}
