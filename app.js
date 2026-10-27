/* =====================================================================
 * Text Diff Studio
 *
 *   1. Configuration   - formats, view modes, options, samples (edit here to extend)
 *   2. Helpers         - small pure functions shared by services
 *   3. Services        - format detection, line diff, structured diff, files
 *   4. Directives      - scroll sync, file loader
 *   5. Controller      - UI state and the compare pipeline
 *
 * External libraries (loaded in index.html):
 *   jsdiff   -> word/char highlighting and .patch export (optional)
 *   js-yaml  -> YAML parsing for Smart compare (optional)
 * The line diff itself is implemented below and has no dependency.
 * ===================================================================== */
(function () {
'use strict';

var app = angular.module('diffStudio', []);

/* ---------------------------------------------------------------------
 * 1. Configuration
 * ------------------------------------------------------------------- */

var LIMITS = {
  largeInput: 5000,       // lines; above this we warn about slow rendering
  maxEditDistance: 3000,  // Myers search cap; beyond it the region is shown as replaced
  valueLength: 120,       // max characters of a value shown in the structural table
  debounceMs: 350
};

var DEFAULT_OPTIONS = {
  ignoreWs: false,        // trim each line
  ignoreAllWs: false,     // remove all whitespace
  ignoreBlank: false,
  ignoreCase: false,
  invisible: false,       // display only
  context: '3',           // unchanged lines kept around a change; 'all' disables folding
  arrayMode: 'index'      // Smart compare: 'index' | 'unordered'
};

/* Flags that change what counts as a difference (shown in the Settings badge). */
var ACTIVE_FLAGS = ['ignoreWs', 'ignoreAllWs', 'ignoreBlank', 'ignoreCase'];

/* view  = layout of the result table ('side' | 'line' | 'unified')
 * intra = highlight inside changed lines ('word' | 'char' | null)        */
var VIEW_MODES = [
  { id: 'line',    label: 'Line by line',    view: 'line',    intra: null },
  { id: 'side',    label: 'Side by side',    view: 'side',    intra: 'word' },
  { id: 'unified', label: 'Unified',         view: 'unified', intra: null },
  { id: 'word',    label: 'Word level',      view: 'line',    intra: 'word' },
  { id: 'char',    label: 'Character level', view: 'line',    intra: 'char' }
];

var ARRAY_MODES = [
  { id: 'index',     label: 'Compare by position' },
  { id: 'unordered', label: 'Ignore order' }
];

var CONTEXT_CHOICES = ['0', '1', '3', '5', 'all'];

/* Detection runs top to bottom; first format with a matching pattern wins.
 * Add a format here and it appears in the UI and in auto-detection.      */
var FORMATS = [
  { id: 'JSON',       ext: ['json'],         detect: [/^[\[{]/] },
  { id: 'XML',        ext: ['xml'],          detect: [/^<\?xml/, /^<[A-Za-z]/] },
  { id: 'Java',       ext: ['java'],         detect: [/\b(public|private)\s+(class|interface)/, /^import\s+[\w.]+;/m, /^package\s/m] },
  { id: 'SQL',        ext: ['sql'],          detect: [/^\s*(select|insert|update|delete|create)\s/i] },
  { id: 'YAML',       ext: ['yaml', 'yml'],  detect: [/^\s*[\w.-]+\s*:(\s|$)/m, /^---/] },
  { id: 'Properties', ext: ['properties'],   detect: [/^\s*[\w.-]+\s*=/m] },
  { id: 'Plain Text', ext: ['txt', 'log'],   detect: [] }
];

var AUTO_DETECT = 'Auto Detect';

var SAMPLES = [
  { id: 'yaml', label: 'Spring Boot YAML', format: 'YAML',
    a: 'server:\n  port: 8080\n  timeout: 30\nspring:\n  datasource:\n    url: jdbc:mysql://db:3306/pay\n    username: app\n  profiles:\n    active: dev\n',
    b: 'spring:\n  profiles:\n    active: prod\n  datasource:\n    url: jdbc:mysql://db:3306/pay\n    username: app\nserver:\n  port: 8081\n  timeout: 30\n  ssl: true\n' },
  { id: 'json', label: 'JSON payload', format: 'JSON',
    a: '{\n  "name": "Wing",\n  "amount": 100,\n  "currency": "KHR",\n  "items": [1, 2]\n}',
    b: '{\n  "name": "Wing",\n  "amount": 200,\n  "currency": "KHR",\n  "active": true,\n  "items": [1, "2"]\n}' },
  { id: 'java', label: 'Java service', format: 'Java',
    a: 'package com.demo;\n\nimport java.util.List;\n\npublic class PayService {\n    public int total(List<Integer> xs) {\n        int sum = 0;\n        for (int x : xs) sum += x;\n        return sum;\n    }\n}\n',
    b: 'package com.demo;\n\nimport java.util.List;\nimport java.math.BigDecimal;\n\n@Service\npublic class PayService {\n    public BigDecimal total(List<BigDecimal> xs) {\n        BigDecimal sum = BigDecimal.ZERO;\n        for (BigDecimal x : xs) sum = sum.add(x);\n        return sum;\n    }\n}\n' },
  { id: 'xml', label: 'XML config', format: 'XML',
    a: '<config>\n  <db host="localhost" port="3306"/>\n  <feature name="qr" enabled="true"/>\n</config>',
    b: '<config>\n  <db host="db.internal" port="3306"/>\n  <feature name="qr" enabled="false"/>\n  <feature name="nfc" enabled="true"/>\n</config>' },
  { id: 'log', label: 'Log / text', format: 'Plain Text',
    a: '2026-10-26 10:00:01 INFO  Start\n2026-10-26 10:00:02 INFO  Callback received id=42\n2026-10-26 10:00:03 INFO  Done\n',
    b: '2026-10-26 10:00:01 INFO  Start\n2026-10-26 10:00:02 WARN  Callback received id=43 retry=1\n2026-10-26 10:00:03 ERROR Timeout\n2026-10-26 10:00:04 INFO  Done\n' }
];

var PREF_KEY = 'diffStudio.prefs.v1';

/* ---------------------------------------------------------------------
 * 2. Helpers
 * ------------------------------------------------------------------- */

var LINE_BREAK = /\r\n|\r|\n/;

function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function splitLines(text) { return text ? text.split(LINE_BREAK) : []; }

/* Apply the whitespace / case options to one piece of text. */
function normalizeText(s, o) {
  if (o.ignoreAllWs) s = s.replace(/\s+/g, '');
  else if (o.ignoreWs) s = s.trim();
  return o.ignoreCase ? s.toLowerCase() : s;
}

function fill(n, value) {
  var out = [], i;
  for (i = 0; i < n; i++) out.push(value);
  return out;
}

/* ---------------------------------------------------------------------
 * 3. Services
 * ------------------------------------------------------------------- */

/* ---------- formatService: detect format from file name or content ---------- */
app.factory('formatService', function () {
  var byExt = {};
  FORMATS.forEach(function (f) { f.ext.forEach(function (e) { byExt[e] = f.id; }); });

  return {
    ids: [AUTO_DETECT].concat(FORMATS.map(function (f) { return f.id; })),

    fromName: function (name) {
      var m = /\.([a-z]+)$/i.exec(name || '');
      return (m && byExt[m[1].toLowerCase()]) || null;
    },

    fromContent: function (text) {
      var s = (text || '').trim(), i, j;
      if (!s) return 'Plain Text';
      for (i = 0; i < FORMATS.length; i++) {
        for (j = 0; j < FORMATS[i].detect.length; j++) {
          if (FORMATS[i].detect[j].test(s)) return FORMATS[i].id;
        }
      }
      return 'Plain Text';
    }
  };
});

/* ---------- lineDiffService: Myers O(ND) diff on arrays of strings ----------
 * Returns an op list: 'e' (equal), 'd' (only in A), 'a' (only in B).
 * Written here instead of using jsdiff.diffArrays because that helper has
 * version-dependent handling of empty items (blank lines) and counts.     */
app.factory('lineDiffService', function () {

  function backtrack(trace, n, m, D) {
    var ops = [], x = n, y = m, d, snap, k, prevK, prevX, prevY;
    for (d = D; d > 0; d--) {
      snap = trace[d];                       // v before round d, index = k + d + 1
      k = x - y;
      if (k === -d || (k !== d && snap[k - 1 + d + 1] < snap[k + 1 + d + 1])) prevK = k + 1;
      else prevK = k - 1;
      prevX = snap[prevK + d + 1];
      prevY = prevX - prevK;
      while (x > prevX && y > prevY) { ops.push('e'); x--; y--; }
      ops.push(x === prevX ? 'a' : 'd');
      x = prevX; y = prevY;
    }
    while (x > 0 && y > 0) { ops.push('e'); x--; y--; }
    return ops.reverse();
  }

  /* Core search. Returns { ops, capped }. */
  function myers(a, b) {
    var n = a.length, m = b.length;
    if (!n) return { ops: fill(m, 'a'), capped: false };
    if (!m) return { ops: fill(n, 'd'), capped: false };

    var max = n + m, limit = Math.min(max, LIMITS.maxEditDistance);
    var off = max + 1, v = new Int32Array(2 * max + 3), trace = [], d, k, x, y;

    for (d = 0; d <= limit; d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (k = -d; k <= d; k += 2) {
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
        else x = v[off + k - 1] + 1;
        y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) return { ops: backtrack(trace, n, m, d), capped: false };
      }
    }
    return { ops: fill(n, 'd').concat(fill(m, 'a')), capped: true };   // too different: show as replaced
  }

  return {
    diff: function (a, b) {
      var start = 0, endA = a.length, endB = b.length, head, tail, mid;
      while (start < endA && start < endB && a[start] === b[start]) start++;
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
      head = fill(start, 'e');
      tail = fill(a.length - endA, 'e');
      mid = myers(a.slice(start, endA), b.slice(start, endB));
      return { ops: head.concat(mid.ops, tail), capped: mid.capped };
    }
  };
});

/* ---------- diffService: rows for the line / side-by-side / unified views ---------- */
app.factory('diffService', function (lineDiffService) {

  /* Split text into lines, honouring ignoreBlank; keep original line numbers. */
  function toLines(text, o) {
    var out = [];
    splitLines(text).forEach(function (s, i) {
      if (o.ignoreBlank && s.trim() === '') return;
      out.push({ s: s, n: normalizeText(s, o), i: i + 1 });
    });
    return out;
  }

  function plain(s) { return [{ t: s, c: '' }]; }

  /* Highlight the changed words/characters between two paired lines. */
  function intraLine(a, b, mode) {
    var parts = mode === 'char' ? Diff.diffChars(a, b) : Diff.diffWordsWithSpace(a, b), as = [], bs = [];
    parts.forEach(function (p) {
      if (p.added) bs.push({ t: p.value, c: 'chg' });
      else if (p.removed) as.push({ t: p.value, c: 'chg' });
      else { as.push({ t: p.value, c: '' }); bs.push({ t: p.value, c: '' }); }
    });
    return { as: as, bs: bs };
  }

  /* Turn an op list into rows. Runs of del+add are paired into 'mod' rows. */
  function buildRows(ops, A, B, intraMode) {
    var rows = [], dels = [], adds = [], ai = 0, bi = 0;

    function flush() {
      var paired = Math.min(dels.length, adds.length), k, x, y, seg;
      for (k = 0; k < paired; k++) {
        x = dels[k]; y = adds[k];
        seg = intraMode ? intraLine(x.s, y.s, intraMode) : { as: plain(x.s), bs: plain(y.s) };
        rows.push({ t: 'mod', an: x.i, bn: y.i, as: seg.as, bs: seg.bs });
      }
      for (k = paired; k < dels.length; k++) rows.push({ t: 'del', an: dels[k].i, bn: '', as: plain(dels[k].s), bs: [] });
      for (k = paired; k < adds.length; k++) rows.push({ t: 'add', an: '', bn: adds[k].i, as: [], bs: plain(adds[k].s) });
      dels = []; adds = [];
    }

    ops.forEach(function (op) {
      if (op === 'd') dels.push(A[ai++]);
      else if (op === 'a') adds.push(B[bi++]);
      else {
        flush();
        rows.push({ t: 'eq', an: A[ai].i, bn: B[bi].i, as: plain(A[ai].s), bs: plain(B[bi].s) });
        ai++; bi++;
      }
    });
    flush();
    return rows;
  }

  function countRows(rows) {
    var st = { add: 0, del: 0, mod: 0, eq: 0 };
    rows.forEach(function (r) { st[r.t]++; });
    return st;
  }

  /* Public: compare two texts -> { rows, stats, longer, capped } */
  function compare(aText, bText, o, intraMode) {
    var A = toLines(aText, o), B = toLines(bText, o);
    var result = lineDiffService.diff(A.map(function (x) { return x.n; }), B.map(function (x) { return x.n; }));
    var rows = buildRows(result.ops, A, B, intraMode);
    return { rows: rows, stats: countRows(rows), longer: Math.max(A.length, B.length), capped: result.capped };
  }

  /* Expand 'mod' rows into a del row + an add row for the single-column views. */
  function toInline(rows) {
    var out = [];
    rows.forEach(function (r) {
      if (r.t === 'mod' || r.t === 'del') out.push({ t: 'del', an: r.an, bn: '', sign: '-', segs: r.as });
      if (r.t === 'mod' || r.t === 'add') out.push({ t: 'add', an: '', bn: r.bn, sign: '+', segs: r.bs });
      if (r.t === 'eq') out.push({ t: 'eq', an: r.an, bn: r.bn, sign: ' ', segs: r.as });
    });
    return out;
  }

  /* Fold unchanged runs that are further than `ctx` lines from a change. */
  function withContext(rows, ctx) {
    if (ctx === 'all') return rows;
    ctx = +ctx;
    var keep = rows.map(function () { return false; }), out = [], hidden = 0;
    rows.forEach(function (r, i) {
      if (r.t === 'eq') return;
      for (var j = Math.max(0, i - ctx); j <= Math.min(rows.length - 1, i + ctx); j++) keep[j] = true;
    });
    rows.forEach(function (r, i) {
      if (keep[i]) {
        if (hidden) { out.push({ t: 'gap', n: hidden }); hidden = 0; }
        out.push(r);
      } else hidden++;
    });
    if (hidden) out.push({ t: 'gap', n: hidden });
    return out;
  }

  /* Indexes of the first row of each change block (for Previous / Next). */
  function changeBlocks(rows) {
    var blocks = [];
    rows.forEach(function (r, i) {
      var prev = rows[i - 1], isChange = r.t !== 'eq' && r.t !== 'gap';
      if (isChange && (!prev || prev.t === 'eq' || prev.t === 'gap')) blocks.push(i);
    });
    return blocks;
  }

  function patch(a, b) {
    return window.Diff ? Diff.createTwoFilesPatch('original', 'modified', a, b, '', '', { context: 3 }) : '';
  }

  return { compare: compare, toInline: toInline, withContext: withContext, changeBlocks: changeBlocks, patch: patch };
});

/* ---------- structuredCompareService: JSON / YAML / XML ---------- */
app.factory('structuredCompareService', function () {

  /* --- value helpers --- */
  function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
  function prep(v) { return v instanceof Date ? v.toISOString() : v; }   // js-yaml yields Dates for timestamps

  function show(v) {
    if (v === undefined) return '';
    var s = JSON.stringify(v);
    return s && s.length > LIMITS.valueLength ? s.slice(0, LIMITS.valueLength - 3) + '...' : s;
  }

  function scalar(v, o) { return typeof v === 'string' ? normalizeText(v, o) : v; }

  /* Canonical string: equal values give equal strings (key order ignored). */
  function canon(v, o) {
    v = prep(v);
    var t = typeOf(v), items;
    if (t === 'array') {
      items = v.map(function (x) { return canon(x, o); });
      if (o.arrayMode === 'unordered') items.sort();
      return '[' + items.join(',') + ']';
    }
    if (t === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k], o); }).join(',') + '}';
    }
    return t + ':' + JSON.stringify(scalar(v, o));
  }

  function keyPath(path, key) {
    return path + (/^[A-Za-z_@#][\w@#-]*$/.test(key) ? '.' + key : '["' + key + '"]');
  }

  /* --- tree walk --- */
  function change(kind, label, path, from, to) {
    return { kind: kind, label: label, path: path, from: from, to: to };
  }
  var removed = function (path, v) { return change('removed', 'Removed', path, show(prep(v)), ''); };
  var added   = function (path, v) { return change('added',   'Added',   path, '', show(prep(v))); };

  function walkObject(a, b, path, out, o) {
    var keys = Object.keys(a).concat(Object.keys(b).filter(function (k) { return !has(a, k); }));
    keys.forEach(function (key) {
      var p = keyPath(path, key);
      if (!has(b, key)) out.push(removed(p, a[key]));
      else if (!has(a, key)) out.push(added(p, b[key]));
      else walk(a[key], b[key], p, out, o);
    });
  }

  function walkArrayByIndex(a, b, path, out, o) {
    var len = Math.max(a.length, b.length), k, p;
    for (k = 0; k < len; k++) {
      p = path + '[' + k + ']';
      if (k >= b.length) out.push(removed(p, a[k]));
      else if (k >= a.length) out.push(added(p, b[k]));
      else walk(a[k], b[k], p, out, o);
    }
  }

  /* Match elements by value regardless of position; report only the leftovers. */
  function walkArrayUnordered(a, b, path, out, o) {
    var pool = b.map(function (v, i) { return { key: canon(v, o), v: v, i: i, used: false }; });
    a.forEach(function (v, i) {
      var key = canon(v, o), hit = null, j;
      for (j = 0; j < pool.length && !hit; j++) if (!pool[j].used && pool[j].key === key) hit = pool[j];
      if (hit) hit.used = true;
      else out.push(removed(path + '[' + i + ']', v));
    });
    pool.forEach(function (e) { if (!e.used) out.push(added(path + '[' + e.i + ']', e.v)); });
  }

  function walk(a, b, path, out, o) {
    a = prep(a); b = prep(b);
    var ta = typeOf(a), tb = typeOf(b);
    if (ta !== tb) {
      out.push(change('type', 'Type changed (' + ta + ' → ' + tb + ')', path, show(a), show(b)));
    } else if (ta === 'object') {
      walkObject(a, b, path, out, o);
    } else if (ta === 'array') {
      (o.arrayMode === 'unordered' ? walkArrayUnordered : walkArrayByIndex)(a, b, path, out, o);
    } else if (scalar(a, o) !== scalar(b, o)) {
      out.push(change('changed', 'Changed', path, show(a), show(b)));
    }
  }

  /* --- parsers: one per supported format; each returns a plain JS value --- */
  function xmlToObj(el) {
    var o = {}, text = '', i, n, v;
    for (i = 0; i < el.attributes.length; i++) o['@' + el.attributes[i].name] = el.attributes[i].value;
    for (i = 0; i < el.childNodes.length; i++) {
      n = el.childNodes[i];
      if (n.nodeType === 1) {
        v = xmlToObj(n);
        if (has(o, n.nodeName)) {
          if (!Array.isArray(o[n.nodeName])) o[n.nodeName] = [o[n.nodeName]];
          o[n.nodeName].push(v);
        } else o[n.nodeName] = v;
      } else if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue;
    }
    text = text.trim();
    if (text) { if (Object.keys(o).length) o['#text'] = text; else return text; }
    return Object.keys(o).length || text ? o : '';
  }

  var PARSERS = {
    JSON: { available: function () { return true; }, parse: function (t) { return JSON.parse(t); } },
    YAML: {
      available: function () { return !!window.jsyaml; },
      parse: function (t) { var docs = jsyaml.loadAll(t); return docs.length === 1 ? docs[0] : docs; }
    },
    XML: {
      available: function () { return typeof DOMParser !== 'undefined'; },
      parse: function (t) {
        var doc = new DOMParser().parseFromString(t, 'application/xml'), err = doc.getElementsByTagName('parsererror')[0], root = {};
        if (err) throw new Error(err.textContent.split('\n')[0]);
        root[doc.documentElement.nodeName] = xmlToObj(doc.documentElement);
        return root;
      }
    }
  };

  function errorMessage(e) {
    return e.mark ? e.reason + ' (line ' + (e.mark.line + 1) + ', column ' + (e.mark.column + 1) + ')' : e.message;
  }

  function tryParse(fmt, text, label) {
    try { return { value: PARSERS[fmt].parse(text) }; }
    catch (e) { return { error: label + ' is not valid ' + fmt + ': ' + errorMessage(e) }; }
  }

  return {
    supported: function (fmt) { return has(PARSERS, fmt) && PARSERS[fmt].available(); },

    /* -> { changes: [...] } or { error: 'message' } */
    run: function (fmt, aText, bText, o) {
      var a = tryParse(fmt, aText, 'Original'); if (a.error) return a;
      var b = tryParse(fmt, bText, 'Modified'); if (b.error) return b;
      var out = [];
      walk(a.value, b.value, '$', out, o);
      return { changes: out };
    }
  };
});

/* ---------- fileService: download, clipboard ---------- */
app.factory('fileService', function () {
  function noClipboard() { return Promise.reject(new Error('Clipboard unavailable')); }
  return {
    download: function (text, name) {
      var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 500);
    },
    copy:  function (text) { return navigator.clipboard ? navigator.clipboard.writeText(text) : noClipboard(); },
    paste: function ()     { return navigator.clipboard ? navigator.clipboard.readText() : noClipboard(); }
  };
});

/* ---------- prefsService: remember theme and options (best effort) ---------- */
app.factory('prefsService', function () {
  return {
    load: function () { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; } },
    save: function (prefs) { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* storage unavailable */ } }
  };
});

/* ---------------------------------------------------------------------
 * 4. Directives
 * ------------------------------------------------------------------- */

/* Keep the line-number gutter (previous sibling) aligned with the textarea. */
app.directive('syncScroll', function () {
  return {
    link: function (scope, el) {
      el.on('scroll', function () {
        var gutter = el[0].previousElementSibling;
        if (gutter) gutter.scrollTop = el[0].scrollTop;
      });
    }
  };
});

/* <input type="file" file-load="fn(file, text)"> */
app.directive('fileLoad', function () {
  return {
    scope: { fileLoad: '&' },
    link: function (scope, el) {
      el.on('change', function () {
        var file = el[0].files[0], reader;
        if (!file) return;
        reader = new FileReader();
        reader.onload = function () { scope.$apply(function () { scope.fileLoad({ file: file, text: reader.result }); }); };
        reader.readAsText(file);
        el[0].value = '';
      });
    }
  };
});

/* ---------------------------------------------------------------------
 * 5. Controller
 * ------------------------------------------------------------------- */
app.controller('MainCtrl', function ($timeout, diffService, structuredCompareService, formatService, fileService, prefsService) {
  var vm = this, timer, pendingPane;
  var prefs = prefsService.load();

  /* ----- static lists for the template ----- */
  vm.formats = formatService.ids;
  vm.modes = VIEW_MODES;
  vm.arrayModes = ARRAY_MODES;
  vm.contextChoices = CONTEXT_CHOICES;
  vm.samples = SAMPLES;

  /* ----- state ----- */
  vm.format = AUTO_DETECT;
  vm.mode = modeById(prefs.mode) ? prefs.mode : 'side';
  vm.smart = prefs.smart !== false;
  vm.o = angular.extend({}, DEFAULT_OPTIONS, prefs.o);
  vm.theme = prefs.theme || (prefersDark() ? 'dark' : 'light');
  vm.sample = null;
  vm.showSettings = false;
  vm.left = { text: '', name: 'original.txt' };
  vm.right = { text: '', name: 'modified.txt' };
  vm.result = null; vm.rows = []; vm.blocks = []; vm.cur = 0; vm.view = 'side';
  vm.error = '';
  vm.depError = (window.Diff && window.jsyaml) ? '' :
    'A library failed to load from cdnjs (jsdiff or js-yaml). Line diff still works; word/character highlighting, YAML smart compare and .patch export need it.';

  function modeById(id) { return VIEW_MODES.filter(function (m) { return m.id === id; })[0]; }
  function prefersDark() { try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; } }
  function savePrefs() { prefsService.save({ theme: vm.theme, mode: vm.mode, smart: vm.smart, o: vm.o }); }
  vm.savePrefs = savePrefs;

  /* ----- small display helpers used by the template ----- */
  vm.lineCount = function (t) { return splitLines(t).length; };
  vm.gutter = function (t) {
    var n = Math.max(1, vm.lineCount(t)), s = [], i;
    for (i = 1; i <= n; i++) s.push(i);
    return s.join('\n');
  };
  vm.vis = function (s) { return vm.o.invisible ? s.replace(/ /g, '·').replace(/\t/g, '→   ') : s; };
  vm.activeCount = function () { return ACTIVE_FLAGS.filter(function (k) { return vm.o[k]; }).length; };

  /* ----- editor actions ----- */
  vm.toggleTheme = function () { vm.theme = vm.theme === 'dark' ? 'light' : 'dark'; savePrefs(); };
  vm.schedule = function () { $timeout.cancel(timer); timer = $timeout(vm.compare, LIMITS.debounceMs); };
  vm.clear = function (pane) { pane.text = ''; vm.compare(); };
  vm.clearAll = function () { vm.left.text = vm.right.text = ''; vm.error = ''; reset(); };
  vm.swap = function () { var t = vm.left.text; vm.left.text = vm.right.text; vm.right.text = t; vm.compare(); };
  vm.download = fileService.download;

  vm.copy = function (text) {
    fileService.copy(text).catch(function () { $timeout(function () { vm.depError = 'Copy failed: clipboard access was denied by the browser.'; }); });
  };
  vm.paste = function (pane) {
    fileService.paste()
      .then(function (t) { $timeout(function () { pane.text = t; vm.compare(); }); })
      .catch(function () { $timeout(function () { vm.depError = 'Paste failed: allow clipboard access, or paste with Ctrl+V into the editor.'; }); });
  };

  vm.openFile = function (pane) { pendingPane = pane; document.getElementById('filePick').click(); };
  vm.fileChosen = function (file, text) {
    pendingPane.text = text; pendingPane.name = file.name;
    var f = formatService.fromName(file.name);
    if (f) vm.format = f;
    vm.compare();
  };

  vm.loadSample = function () {
    var s = SAMPLES.filter(function (x) { return x.id === vm.sample; })[0];
    if (!s) return;
    vm.left.text = s.a; vm.right.text = s.b; vm.format = s.format;
    vm.left.name = 'original'; vm.right.name = 'modified';
    vm.sample = null;
    vm.compare();
  };

  /* ----- compare pipeline ----- */
  function reset() { vm.result = null; vm.rows = []; vm.blocks = []; vm.cur = 0; }

  function inputWarnings(a, b) {
    var w = [];
    if (!a || !b) w.push('Only one input has content; the other side is treated as empty.');
    if (vm.lineCount(a) > LIMITS.largeInput || vm.lineCount(b) > LIMITS.largeInput) {
      w.push('Large input: comparison is complete but rendering may be slow. Use fewer context lines to reduce rows.');
    }
    return w;
  }

  /* Structured comparison is optional; on failure fall back to the text diff. */
  function structuredResult(fmt, a, b, warnings) {
    var out = { changes: null, parse: 'n/a (text)' }, s;
    if (!vm.smart || !a || !b || !structuredCompareService.supported(fmt)) return out;
    s = structuredCompareService.run(fmt, a, b, vm.o);
    if (s.error) { warnings.push('Structured comparison unavailable, showing text diff. ' + s.error); out.parse = 'Failed'; }
    else { out.changes = s.changes; out.parse = 'Valid ' + fmt; }
    return out;
  }

  function run() {
    var a = vm.left.text, b = vm.right.text;
    if (!a && !b) return reset();

    var warnings = inputWarnings(a, b);
    var fmt = vm.format === AUTO_DETECT ? formatService.fromContent(a || b) : vm.format;
    var mode = modeById(vm.mode) || VIEW_MODES[1];
    var text = diffService.compare(a, b, vm.o, window.Diff ? mode.intra : null);
    var st = text.stats, struct = structuredResult(fmt, a, b, warnings);

    if (text.capped) warnings.push('The inputs are very different, so changed regions are shown as fully replaced.');

    vm.result = {
      stats: st, parse: struct.parse, struct: struct.changes, format: fmt, warnings: warnings,
      same: !st.add && !st.del && !st.mod && (!struct.changes || !struct.changes.length),
      pct: text.longer ? Math.round(1000 * st.eq / text.longer) / 10 : 100
    };

    vm.view = mode.view;
    var rows = vm.view === 'side' ? text.rows : diffService.toInline(text.rows);
    vm.rows = diffService.withContext(rows, vm.o.context);
    vm.blocks = diffService.changeBlocks(vm.rows);
    vm.cur = 0;
  }

  vm.compare = function () {
    $timeout.cancel(timer);
    vm.error = '';
    try { run(); }
    catch (e) { reset(); vm.error = 'Comparison failed: ' + e.message; if (window.console) console.error(e); }
    savePrefs();
  };

  /* ----- patch export and change navigation ----- */
  vm.patch = function () { return diffService.patch(vm.left.text, vm.right.text); };
  vm.isCur = function (i) { return vm.blocks.length > 0 && vm.blocks[vm.cur] === i; };
  vm.step = function (delta) {
    if (!vm.blocks.length) return;
    vm.cur = (vm.cur + delta + vm.blocks.length) % vm.blocks.length;
    $timeout(function () {
      var el = document.getElementById('r' + vm.blocks[vm.cur]);
      if (el) el.scrollIntoView({ block: 'center' });
    });
  };

  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      $timeout(function () { vm.step(e.key === 'ArrowDown' ? 1 : -1); });
    }
  });
});

})();
