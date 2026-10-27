(function () {
'use strict';
var app = angular.module('diffStudio', []);

/* ---------- formatDetectionService ---------- */
app.factory('formatDetectionService', function () {
  var ext = { yaml: 'YAML', yml: 'YAML', json: 'JSON', java: 'Java', xml: 'XML', sql: 'SQL', properties: 'Properties', txt: 'Plain Text', log: 'Plain Text' };
  return {
    fromName: function (n) { var m = /\.([a-z]+)$/i.exec(n || ''); return m && ext[m[1].toLowerCase()] || null; },
    fromContent: function (t) {
      var s = (t || '').trim();
      if (!s) return 'Plain Text';
      if (/^[\[{]/.test(s)) return 'JSON';
      if (/^<\?xml|^<[A-Za-z]/.test(s)) return 'XML';
      if (/\b(public|private)\s+(class|interface)|^import\s+[\w.]+;|^package\s/m.test(s)) return 'Java';
      if (/^\s*(select|insert|update|delete|create)\s/i.test(s)) return 'SQL';
      if (/^\s*[\w.-]+\s*:(\s|$)/m.test(s) || /^---/.test(s)) return 'YAML';
      if (/^\s*[\w.-]+\s*=/m.test(s)) return 'Properties';
      return 'Plain Text';
    }
  };
});

/* ---------- diffService: line / word / char / unified (wraps jsdiff) ---------- */
app.factory('diffService', function () {
  function norm(s, o) {
    if (o.ignoreAllWs) s = s.replace(/\s+/g, ''); else if (o.ignoreWs) s = s.trim();
    return o.ignoreCase ? s.toLowerCase() : s;
  }
  function split(t, o) {
    var out = [];
    (t === '' ? [] : t.split(/\r\n|\r|\n/)).forEach(function (s, i) {
      if (o.ignoreBlank && s.trim() === '') return;
      out.push({ s: s, n: norm(s, o), i: i + 1 });
    });
    return out;
  }
  function intra(a, b, mode) {
    var d = mode === 'char' ? Diff.diffChars(a, b) : Diff.diffWordsWithSpace(a, b), as = [], bs = [];
    d.forEach(function (p) {
      if (p.added) bs.push({ t: p.value, c: 'chg' });
      else if (p.removed) as.push({ t: p.value, c: 'chg' });
      else { as.push({ t: p.value, c: '' }); bs.push({ t: p.value, c: '' }); }
    });
    return { as: as, bs: bs };
  }
  function plain(s) { return [{ t: s, c: '' }]; }

  function compare(aText, bText, o, intraMode) {
    var A = split(aText, o), B = split(bText, o), rows = [], dels = [], adds = [], ai = 0, bi = 0, k;
    function flush() {
      var m = Math.min(dels.length, adds.length), k;
      for (k = 0; k < m; k++) {
        var x = dels[k], y = adds[k], seg = intraMode ? intra(x.s, y.s, intraMode) : { as: plain(x.s), bs: plain(y.s) };
        rows.push({ t: 'mod', an: x.i, bn: y.i, as: seg.as, bs: seg.bs });
      }
      for (k = m; k < dels.length; k++) rows.push({ t: 'del', an: dels[k].i, bn: '', as: plain(dels[k].s), bs: [] });
      for (k = m; k < adds.length; k++) rows.push({ t: 'add', an: '', bn: adds[k].i, as: [], bs: plain(adds[k].s) });
      dels = []; adds = [];
    }
    Diff.diffArrays(A.map(function (x) { return x.n; }), B.map(function (x) { return x.n; })).forEach(function (p) {
      for (k = 0; k < p.count; k++) {
        if (p.removed) dels.push(A[ai++]);
        else if (p.added) adds.push(B[bi++]);
        else { flush(); rows.push({ t: 'eq', an: A[ai].i, bn: B[bi].i, as: plain(A[ai].s), bs: plain(B[bi].s) }); ai++; bi++; }
      }
    });
    flush();
    var st = { add: 0, del: 0, mod: 0, eq: 0 };
    rows.forEach(function (r) { st[r.t]++; });
    return { rows: rows, stats: st, longer: Math.max(A.length, B.length) };
  }

  /* Expand modified rows into del+add for inline / unified views */
  function inline(rows) {
    var out = [];
    rows.forEach(function (r) {
      if (r.t === 'mod') {
        out.push({ t: 'del', an: r.an, bn: '', sign: '-', segs: r.as });
        out.push({ t: 'add', an: '', bn: r.bn, sign: '+', segs: r.bs });
      } else if (r.t === 'del') out.push({ t: 'del', an: r.an, bn: '', sign: '-', segs: r.as });
      else if (r.t === 'add') out.push({ t: 'add', an: '', bn: r.bn, sign: '+', segs: r.bs });
      else out.push({ t: 'eq', an: r.an, bn: r.bn, sign: ' ', segs: r.as });
    });
    return out;
  }

  /* Collapse unchanged runs beyond `ctx` lines of context */
  function withContext(rows, ctx) {
    if (ctx === 'all') return rows;
    ctx = +ctx;
    var keep = rows.map(function () { return false; });
    rows.forEach(function (r, i) {
      if (r.t !== 'eq') for (var j = Math.max(0, i - ctx); j <= Math.min(rows.length - 1, i + ctx); j++) keep[j] = true;
    });
    var out = [], hidden = 0;
    rows.forEach(function (r, i) {
      if (keep[i]) { if (hidden) { out.push({ t: 'gap', n: hidden }); hidden = 0; } out.push(r); } else hidden++;
    });
    if (hidden) out.push({ t: 'gap', n: hidden });
    return out;
  }

  function patch(a, b) { return Diff.createTwoFilesPatch('original', 'modified', a, b, '', '', { context: 3 }); }
  return { compare: compare, inline: inline, withContext: withContext, patch: patch };
});

/* ---------- structuredCompareService: JSON / YAML / XML ---------- */
app.factory('structuredCompareService', function () {
  function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
  function show(v) { if (v === undefined) return ''; var s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v); return s && s.length > 120 ? s.slice(0, 117) + '...' : s; }
  function walk(a, b, path, out, o) {
    var ta = typeOf(a), tb = typeOf(b), k;
    if (ta !== tb) return out.push({ kind: 'type', label: 'Type changed (' + ta + ' → ' + tb + ')', path: path, from: show(a), to: show(b) });
    if (ta === 'object') {
      var keys = Object.keys(a).concat(Object.keys(b).filter(function (x) { return !(x in a); }));
      keys.forEach(function (key) {
        var p = path + (/^[A-Za-z_@#][\w@#-]*$/.test(key) ? '.' + key : '["' + key + '"]');
        if (!(key in b)) out.push({ kind: 'removed', label: 'Removed', path: p, from: show(a[key]), to: '' });
        else if (!(key in a)) out.push({ kind: 'added', label: 'Added', path: p, from: '', to: show(b[key]) });
        else walk(a[key], b[key], p, out, o);
      });
    } else if (ta === 'array') {
      for (k = 0; k < Math.max(a.length, b.length); k++) {
        var p2 = path + '[' + k + ']';
        if (k >= b.length) out.push({ kind: 'removed', label: 'Removed', path: p2, from: show(a[k]), to: '' });
        else if (k >= a.length) out.push({ kind: 'added', label: 'Added', path: p2, from: '', to: show(b[k]) });
        else walk(a[k], b[k], p2, out, o);
      }
    } else {
      var x = a, y = b;
      if (o.ignoreCase && ta === 'string') { x = a.toLowerCase(); y = b.toLowerCase(); }
      if (o.ignoreWs && ta === 'string') { x = x.trim(); y = y.trim(); }
      if (x !== y) out.push({ kind: 'changed', label: 'Changed', path: path, from: show(a), to: show(b) });
    }
  }
  function xmlToObj(el) {
    var o = {}, i, txt = '';
    for (i = 0; i < el.attributes.length; i++) o['@' + el.attributes[i].name] = el.attributes[i].value;
    for (i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 1) {
        var v = xmlToObj(n);
        if (n.nodeName in o) { if (!Array.isArray(o[n.nodeName])) o[n.nodeName] = [o[n.nodeName]]; o[n.nodeName].push(v); } else o[n.nodeName] = v;
      } else if (n.nodeType === 3 || n.nodeType === 4) txt += n.nodeValue;
    }
    txt = txt.trim();
    if (txt) { if (Object.keys(o).length) o['#text'] = txt; else return txt; }
    return Object.keys(o).length || txt ? o : '';
  }
  function parse(fmt, text) {
    if (fmt === 'JSON') return JSON.parse(text);
    if (fmt === 'YAML') {
      var docs = jsyaml.loadAll(text);
      return docs.length === 1 ? docs[0] : docs;
    }
    var doc = new DOMParser().parseFromString(text, 'application/xml'), err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error(err.textContent.split('\n')[0]);
    var root = {}; root[doc.documentElement.nodeName] = xmlToObj(doc.documentElement);
    return root;
  }
  function errMsg(e) { return e.mark ? e.reason + ' (line ' + (e.mark.line + 1) + ', column ' + (e.mark.column + 1) + ')' : e.message; }
  return {
    supported: function (f) { return f === 'JSON' || f === 'YAML' || f === 'XML'; },
    run: function (fmt, a, b, o) {
      var pa, pb, out = [];
      try { pa = parse(fmt, a); } catch (e) { return { error: 'Original is not valid ' + fmt + ': ' + errMsg(e) }; }
      try { pb = parse(fmt, b); } catch (e) { return { error: 'Modified is not valid ' + fmt + ': ' + errMsg(e) }; }
      walk(pa, pb, '$', out, o);
      return { changes: out };
    }
  };
});

/* ---------- fileService ---------- */
app.factory('fileService', function () {
  return {
    download: function (text, name) {
      var u = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a');
      a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 500);
    },
    copy: function (text) { return navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('Clipboard unavailable')); },
    paste: function () { return navigator.clipboard ? navigator.clipboard.readText() : Promise.reject(new Error('Clipboard unavailable')); }
  };
});

app.directive('syncScroll', function () {
  return { link: function (s, el) { el.on('scroll', function () { var g = el[0].previousElementSibling; if (g) g.scrollTop = el[0].scrollTop; }); } };
});
app.directive('fileLoad', function () {
  return { scope: { fileLoad: '&' }, link: function (s, el) {
    el.on('change', function () {
      var f = el[0].files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { s.$apply(function () { s.fileLoad({ file: f, text: r.result }); }); };
      r.readAsText(f); el[0].value = '';
    });
  } };
});

/* ---------- samples ---------- */
var SAMPLES = {
  yaml: ['server:\n  port: 8080\n  timeout: 30\nspring:\n  datasource:\n    url: jdbc:mysql://db:3306/pay\n    username: app\n  profiles:\n    active: dev\n',
         'spring:\n  profiles:\n    active: prod\n  datasource:\n    url: jdbc:mysql://db:3306/pay\n    username: app\nserver:\n  port: 8081\n  timeout: 30\n  ssl: true\n'],
  json: ['{\n  "name": "Wing",\n  "amount": 100,\n  "currency": "KHR",\n  "items": [1, 2]\n}', '{\n  "name": "Wing",\n  "amount": 200,\n  "currency": "KHR",\n  "active": true,\n  "items": [1, "2"]\n}'],
  java: ['package com.demo;\n\nimport java.util.List;\n\npublic class PayService {\n    public int total(List<Integer> xs) {\n        int sum = 0;\n        for (int x : xs) sum += x;\n        return sum;\n    }\n}\n',
         'package com.demo;\n\nimport java.util.List;\nimport java.math.BigDecimal;\n\n@Service\npublic class PayService {\n    public BigDecimal total(List<BigDecimal> xs) {\n        BigDecimal sum = BigDecimal.ZERO;\n        for (BigDecimal x : xs) sum = sum.add(x);\n        return sum;\n    }\n}\n'],
  xml: ['<config>\n  <db host="localhost" port="3306"/>\n  <feature name="qr" enabled="true"/>\n</config>', '<config>\n  <db host="db.internal" port="3306"/>\n  <feature name="qr" enabled="false"/>\n  <feature name="nfc" enabled="true"/>\n</config>'],
  log: ['2026-10-26 10:00:01 INFO  Start\n2026-10-26 10:00:02 INFO  Callback received id=42\n2026-10-26 10:00:03 INFO  Done\n', '2026-10-26 10:00:01 INFO  Start\n2026-10-26 10:00:02 WARN  Callback received id=43 retry=1\n2026-10-26 10:00:03 ERROR Timeout\n2026-10-26 10:00:04 INFO  Done\n']
};
var SAMPLE_FMT = { yaml: 'YAML', json: 'JSON', java: 'Java', xml: 'XML', log: 'Plain Text' };

/* ---------- controller ---------- */
app.controller('MainCtrl', function ($timeout, diffService, structuredCompareService, formatDetectionService, fileService) {
  var vm = this, timer, pendingPane;
  vm.formats = ['Auto Detect', 'Plain Text', 'YAML', 'JSON', 'Java', 'XML', 'SQL', 'Properties', 'Custom'];
  vm.format = 'Auto Detect'; vm.mode = 'side'; vm.smart = true; vm.theme = 'light'; vm.sample = '';
  vm.hideInputs = false;
  vm.o = { intra: 'word', wrap: true, fontSize: '13', ignoreWs: false, ignoreAllWs: false, ignoreBlank: false, ignoreCase: false, invisible: false, context: '3' };
  vm.left = { text: '', name: 'original.txt' }; vm.right = { text: '', name: 'modified.txt' };
  vm.result = null; vm.rows = []; vm.blocks = []; vm.cur = 0; vm.view = 'side';
  vm.depError = (window.Diff && window.jsyaml) ? '' : 'A required library failed to load from cdnjs (jsdiff or js-yaml). Check your connection; comparison is unavailable until it loads.';
  try { if (window.matchMedia('(prefers-color-scheme: dark)').matches) vm.theme = 'dark'; } catch (e) { /* ignore */ }

  vm.toggleTheme = function () { vm.theme = vm.theme === 'dark' ? 'light' : 'dark'; };
  vm.lineCount = function (t) { return t ? t.split(/\r\n|\r|\n/).length : 0; };
  vm.gutter = function (t) { var n = Math.max(1, vm.lineCount(t)), s = []; for (var i = 1; i <= n; i++) s.push(i); return s.join('\n'); };
  vm.vis = function (s) { return vm.o.invisible ? s.replace(/ /g, '·').replace(/\t/g, '→   ') : s; };
  vm.activeCount = function () { var n = 0; ['ignoreWs', 'ignoreAllWs', 'ignoreBlank', 'ignoreCase'].forEach(function (k) { if (vm.o[k]) n++; }); return n; };

  vm.schedule = function () { $timeout.cancel(timer); timer = $timeout(vm.compare, 350); };
  vm.clear = function (p) { p.text = ''; vm.compare(); };
  vm.clearAll = function () { vm.left.text = vm.right.text = ''; vm.result = null; vm.rows = []; vm.blocks = []; };
  vm.swap = function () { var t = vm.left.text; vm.left.text = vm.right.text; vm.right.text = t; vm.compare(); };
  vm.copy = function (t) { fileService.copy(t).catch(function () { vm.depError = 'Copy failed: clipboard access was denied by the browser.'; }); };
  vm.download = fileService.download;
  vm.paste = function (p) {
    fileService.paste().then(function (t) { $timeout(function () { p.text = t; vm.compare(); }); })
      .catch(function () { $timeout(function () { vm.depError = 'Paste failed: allow clipboard access, or paste with Ctrl+V into the editor.'; }); });
  };
  vm.openFile = function (p) { pendingPane = p; document.getElementById('filePick').click(); };
  vm.fileChosen = function (file, text) {
    pendingPane.text = text; pendingPane.name = file.name;
    var f = formatDetectionService.fromName(file.name); if (f) vm.format = f;
    vm.compare();
  };
  vm.loadSample = function () {
    var s = SAMPLES[vm.sample]; if (!s) return;
    vm.left.text = s[0]; vm.right.text = s[1]; vm.format = SAMPLE_FMT[vm.sample];
    vm.left.name = 'original'; vm.right.name = 'modified'; vm.sample = ''; vm.compare();
  };

  vm.compare = function () {
    $timeout.cancel(timer);
    if (!window.Diff) return;
    var a = vm.left.text, b = vm.right.text, warnings = [], fmt = vm.format;
    if (!a && !b) { vm.result = null; vm.rows = []; vm.blocks = []; return; }
    if (!a || !b) warnings.push('Only one input has content; the other side is treated as empty.');
    if (vm.lineCount(a) > 5000 || vm.lineCount(b) > 5000) warnings.push('Large input: comparison is complete but rendering may be slow. Use fewer context lines to reduce rows.');
    if (fmt === 'Auto Detect') fmt = formatDetectionService.fromContent(a || b);
    var mode = vm.mode, intraMode = mode === 'word' ? 'word' : mode === 'char' ? 'char' : (vm.o.intra === 'off' ? null : vm.o.intra);
    var r = diffService.compare(a, b, vm.o, intraMode), parse = 'n/a (text)', struct = null;
    if (vm.smart && structuredCompareService.supported(fmt) && a && b) {
      var s = structuredCompareService.run(fmt, a, b, vm.o);
      if (s.error) { warnings.push('Structured comparison unavailable, showing text diff. ' + s.error); parse = 'Failed'; } else { struct = s.changes; parse = 'Valid ' + fmt; }
    }
    var total = r.rows.length ? r.stats.eq + r.stats.mod + r.stats.add + r.stats.del : 0;
    vm.result = {
      stats: r.stats, parse: parse, struct: struct, format: fmt, warnings: warnings,
      same: !r.stats.add && !r.stats.del && !r.stats.mod && (!struct || !struct.length),
      pct: r.longer ? Math.round(1000 * r.stats.eq / r.longer) / 10 : 100
    };
    vm.view = mode === 'unified' ? 'unified' : (mode === 'line' ? 'line' : 'side');
    var rows = vm.view === 'side' ? r.rows : diffService.inline(r.rows);
    vm.rows = diffService.withContext(rows, vm.o.context);
    vm.blocks = [];
    vm.rows.forEach(function (x, i) { var prev = vm.rows[i - 1]; if (x.t !== 'eq' && x.t !== 'gap' && (!prev || prev.t === 'eq' || prev.t === 'gap')) vm.blocks.push(i); });
    vm.cur = 0;
  };

  vm.patch = function () { return diffService.patch(vm.left.text, vm.right.text); };
  vm.isCur = function (i) { return vm.blocks.length && vm.blocks[vm.cur] === i; };
  vm.step = function (d) {
    if (!vm.blocks.length) return;
    vm.cur = (vm.cur + d + vm.blocks.length) % vm.blocks.length;
    $timeout(function () { var el = document.getElementById('r' + vm.blocks[vm.cur]); if (el) el.scrollIntoView({ block: 'center' }); });
  };
  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); $timeout(function () { vm.step(e.key === 'ArrowDown' ? 1 : -1); }); }
  });
});
})();
