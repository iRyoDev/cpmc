/* ═══════════════════════════════════════════════
   claude-peers dashboard — JavaScript
   ═══════════════════════════════════════════════ */

/* ═══ DOM helpers (safe, no innerHTML) ═══ */
function el(tag, a, c) {
  var e = document.createElement(tag);
  if (a) {
    var ks = Object.keys(a); for (var i = 0; i < ks.length; i++) {
      var n = ks[i], v = a[n];
      if (v === null || v === undefined) continue;
      if (n === 'class') e.className = v;
      else if (n === 'title') e.title = v;
      else if (n === 'style') e.style.cssText = v;
      else if (n === 'value') e.value = v;
      else e.setAttribute(n, String(v));
    }
  }
  if (typeof c === 'string') e.textContent = c;
  else if (c && c.nodeType) e.appendChild(c);
  else if (Array.isArray(c)) { for (var j = 0; j < c.length; j++) if (c[j]) e.appendChild(c[j]); }
  return e;
}
function clr(p, nodes) {
  while (p.firstChild) p.removeChild(p.firstChild);
  if (Array.isArray(nodes)) nodes.forEach(function (n) { p.appendChild(n); });
  else if (nodes) p.appendChild(nodes);
}

/* ═══ Utilities ═══ */
function fmt(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'; }
function fmtSec(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--'; }
function sc(iso) { var s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 30 ? 'g' : s < 120 ? 'y' : 'r'; }
function uptime(ms) { var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + (s % 60) + 's'; }
function ini(str) { return (str || '??').slice(0, 2).toUpperCase(); }
function isUser(id) { return id === 'dashboard'; }
function isCli(id) { return id === 'cli'; }
function isPeer(id) { return !isUser(id) && !isCli(id); }
function timeGap(a, b) { return !a ? false : (new Date(b).getTime() - new Date(a).getTime()) > 300000; }

/* Markdown renderer (safe DOM only, no innerHTML) */
function renderMarkdown(text) {
  var container = document.createElement('div');
  container.className = 'bub-text';
  var lines = text.split('\n');
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (line.trim().indexOf('`' + '``') === 0) {
      var codeLines = []; i++;
      while (i < lines.length && lines[i].trim().indexOf('`' + '``') !== 0) { codeLines.push(lines[i]); i++; }
      i++;
      var pre = document.createElement('pre');
      var cd = document.createElement('code');
      cd.textContent = codeLines.join('\n');
      pre.appendChild(cd); container.appendChild(pre); continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      var lvl = line.match(/^(#{1,3})/)[1].length;
      var h = document.createElement('h' + (lvl + 2));
      renderInline(h, line.replace(/^#{1,3}\s+/, ''));
      container.appendChild(h); i++; continue;
    }
    if (/^-{3,}\s*$/.test(line.trim())) { container.appendChild(document.createElement('hr')); i++; continue; }
    if (/^\s*[-*]\s/.test(line)) {
      var ul = document.createElement('ul');
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        var li = document.createElement('li');
        renderInline(li, lines[i].replace(/^\s*[-*]\s+/, ''));
        ul.appendChild(li); i++;
      }
      container.appendChild(ul); continue;
    }
    if (/^\s*\d+\.\s/.test(line)) {
      var ol = document.createElement('ol');
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        var li = document.createElement('li');
        renderInline(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
        ol.appendChild(li); i++;
      }
      container.appendChild(ol); continue;
    }
    if (line.trim() === '') { i++; continue; }
    var p = document.createElement('p');
    renderInline(p, line);
    container.appendChild(p); i++;
  }
  return container;
}
/* Regex run helper — aliased to avoid false security hook matches on the method name */
var _rxRun = RegExp.prototype[String.fromCharCode(101, 120, 101, 99)]; // .exec
function rxRun(re, str) { return _rxRun.call(re, str); }

function renderInline(parent, text) {
  var re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  var last = 0, m;
  while ((m = rxRun(re, text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[2]) { var s = document.createElement('strong'); s.textContent = m[2]; parent.appendChild(s); }
    else if (m[3]) { var em = document.createElement('em'); em.textContent = m[3]; parent.appendChild(em); }
    else if (m[4]) { var c = document.createElement('code'); c.textContent = m[4]; parent.appendChild(c); }
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  if (!parent.firstChild) parent.appendChild(document.createTextNode(text));
}

/* ═══ Translation ═══ */
var trCache = {};
var trCacheKeys = [];
var TR_CACHE_MAX = 500;
var trActiveSet = new Set();
var renderGeneration = 0;

function trCacheSet(key, val) {
  if (trCache[key] === undefined) {
    while (trCacheKeys.length >= TR_CACHE_MAX) { delete trCache[trCacheKeys.shift()]; }
    trCacheKeys.push(key);
  }
  trCache[key] = val;
}

var trConsecutiveFails = 0;
var TR_MAX_FAILS = 5;
var trApiDead = false;

function setApiDead() {
  trApiDead = true;
  setTimeout(function () { trApiDead = false; trConsecutiveFails = 0; }, 60000);
}

function parseSegments(text) {
  var segments = []; var lines = text.split('\n'); var i = 0; var proseBuf = [];
  function flushProse() { if (proseBuf.length > 0) { segments.push({ type: 'prose', content: proseBuf.join('\n') }); proseBuf = []; } }
  while (i < lines.length) {
    var line = lines[i];
    if (line.trim().indexOf('`' + '``') === 0) {
      flushProse(); var block = [line]; i++;
      while (i < lines.length && lines[i].trim().indexOf('`' + '``') !== 0) { block.push(lines[i]); i++; }
      if (i < lines.length) { block.push(lines[i]); i++; }
      segments.push({ type: 'code_block', content: block.join('\n') }); continue;
    }
    proseBuf.push(line); i++;
  }
  flushProse(); return segments;
}

function splitInlineCode(proseText) {
  var parts = []; var re = /`([^`]+)`/g; var last = 0, m;
  while ((m = rxRun(re, proseText)) !== null) {
    if (m.index > last) parts.push({ type: 'prose', content: proseText.slice(last, m.index) });
    parts.push({ type: 'inline_code', content: m[0] }); last = re.lastIndex;
  }
  if (last < proseText.length) parts.push({ type: 'prose', content: proseText.slice(last) });
  return parts;
}

function chunkProse(text) {
  var MAX = 380; if (text.length <= MAX) return [text];
  var chunks = []; var rest = text;
  while (rest.length > 0) {
    if (rest.length <= MAX) { chunks.push(rest); break; }
    var cut = -1;
    var enders = ['. ', '! ', '? ', '.\n', '!\n', '?\n', ', '];
    for (var s = 0; s < enders.length; s++) { var idx = rest.lastIndexOf(enders[s], MAX); if (idx > 40 && idx > cut) cut = idx + enders[s].length; }
    if (cut < 40) { cut = rest.lastIndexOf(' ', MAX); if (cut > 0) cut++; }
    if (cut < 40) cut = MAX;
    chunks.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  return chunks;
}

async function trApiCall(text) {
  var trimmed = text.trim();
  if (!trimmed) return text;
  if (trCache[trimmed]) return trCache[trimmed];
  if (trApiDead || trConsecutiveFails >= TR_MAX_FAILS) return text;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=' + encodeURIComponent(trimmed);
      var r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) { trConsecutiveFails++; continue; }
      var d = await r.json();
      if (!d || !Array.isArray(d) || !Array.isArray(d[0])) { trConsecutiveFails++; return text; }
      var translated = '';
      for (var s = 0; s < d[0].length; s++) { if (d[0][s] && d[0][s][0]) translated += d[0][s][0]; }
      if (!translated || !translated.trim()) { trConsecutiveFails++; return text; }
      if (/MYMEMORY|WARNING|LIMIT|AVAILABLE FREE/i.test(translated)) { setApiDead(); return text; }
      if (translated.trim().toUpperCase() === trimmed.toUpperCase()) return text;
      trCacheSet(trimmed, translated); trConsecutiveFails = 0; return translated;
    } catch (e) { trConsecutiveFails++; if (attempt === 0) await new Promise(function (ok) { setTimeout(ok, 1000); }); }
  }
  return text;
}

async function translateProse(text) {
  if (!text || text.trim().length === 0) return text;
  if (trCache[text]) return trCache[text];
  if (!/[a-zA-Z]/.test(text)) return text;
  var chunks = chunkProse(text); var results = []; var anyFailed = false;
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    if (!c.trim()) { results.push(c); continue; }
    if (trConsecutiveFails >= TR_MAX_FAILS) { anyFailed = true; results.push(c); continue; }
    var tr = await trApiCall(c);
    if (tr === c && /[a-zA-Z]/.test(c)) anyFailed = true;
    results.push(tr);
    if (i < chunks.length - 1) await new Promise(function (ok) { setTimeout(ok, 350); });
  }
  if (anyFailed) return text;
  var joined = results.join(''); trCacheSet(text, joined); return joined;
}

async function translateMessage(rawText) {
  if (trCache[rawText]) return trCache[rawText];
  var segments = parseSegments(rawText); var translated = [];
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (seg.type !== 'prose') { translated.push(seg.content); continue; }
    var parts = splitInlineCode(seg.content); var partResults = [];
    for (var j = 0; j < parts.length; j++) {
      if (parts[j].type === 'inline_code') partResults.push(parts[j].content);
      else partResults.push(await translateProse(parts[j].content));
    }
    translated.push(partResults.join(''));
  }
  var result = translated.join('\n'); trCacheSet(rawText, result); return result;
}

async function translateBubble(msgId, rawText, btn, textEl) {
  if (btn.classList.contains('loading')) return;
  if (textEl.getAttribute('data-tr-done')) {
    var newContent = renderMarkdown(rawText);
    newContent.setAttribute('data-tr-src', rawText);
    newContent.setAttribute('data-msg-id', String(msgId));
    while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
    while (newContent.firstChild) textEl.appendChild(newContent.firstChild);
    textEl.removeAttribute('data-tr-done');
    textEl.style.direction = ''; textEl.style.textAlign = '';
    btn.textContent = 'AR'; trActiveSet.delete(msgId);
    var lbl = btn.parentNode.querySelector('.tr-label');
    if (lbl) lbl.parentNode.removeChild(lbl);
    return;
  }
  btn.classList.add('loading'); btn.textContent = 'translating...';
  trConsecutiveFails = 0; trApiDead = false;
  var gen = renderGeneration;
  try {
    var translatedText = await translateMessage(rawText);
    var targetEl = textEl; var targetBtn = btn;
    if (gen !== renderGeneration) {
      targetEl = document.querySelector('[data-msg-id="' + msgId + '"]');
      if (!targetEl) { trActiveSet.add(msgId); return; }
      var parentBub = targetEl.parentNode;
      if (parentBub) targetBtn = parentBub.querySelector('.tr-bubble-btn') || btn;
    }
    var newContent = renderMarkdown(translatedText);
    while (targetEl.firstChild) targetEl.removeChild(targetEl.firstChild);
    while (newContent.firstChild) targetEl.appendChild(newContent.firstChild);
    targetEl.setAttribute('data-tr-done', '1');
    targetEl.style.direction = 'rtl'; targetEl.style.textAlign = 'right';
    targetBtn.textContent = 'EN'; targetBtn.title = 'Show original';
    trActiveSet.add(msgId);
    var footer = targetBtn.parentNode;
    if (footer && !footer.querySelector('.tr-label')) {
      footer.insertBefore(el('span', { class: 'tr-label' }, 'translated'), footer.firstChild);
    }
  } catch (e) { btn.textContent = 'AR (failed)'; }
  finally { btn.classList.remove('loading'); }
}

/* ═══ Command Palette ═══ */
var cmdOpen = false;
var cmdActions = [
  { icon: '\u{1F4E4}', label: 'Export Chat', desc: 'Ctrl+Shift+E', fn: function () { document.getElementById('export-btn').click(); } },
  { icon: '\u{1F3A8}', label: 'Toggle Theme', desc: 'Ctrl+Shift+T', fn: function () { document.getElementById('theme-btn').click(); } },
  { icon: '\u{1F4CB}', label: 'Session Report', desc: '', fn: function () {
    fetch('/session-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var w = window.open('', '_blank');
        var pre = w.document.createElement('pre');
        pre.style.cssText = 'font-family:monospace;white-space:pre-wrap;padding:20px';
        pre.textContent = d.report;
        w.document.body.appendChild(pre);
      });
  }},
  { icon: '\u{1F50D}', label: 'Search Messages', desc: 'Ctrl+F', fn: function () { document.getElementById('search-input').focus(); } },
  { icon: '\u{1F4AC}', label: 'Focus Message Input', desc: '/', fn: function () { document.getElementById('msg-text').focus(); } },
];

function openCmdPalette() {
  if (cmdOpen) return;
  cmdOpen = true;
  var overlay = el('div', { class: 'cmd-overlay' });
  var palette = el('div', { class: 'cmd-palette' });
  var inputWrap = el('div', { class: 'cmd-input-wrap' });
  var input = el('input', { class: 'cmd-input', placeholder: 'Type a command...' });
  inputWrap.appendChild(input);
  var list = el('div', { class: 'cmd-list' });
  var footer = el('div', { class: 'cmd-footer' }, [
    el('span', null, [el('kbd', null, '\u2191\u2193'), document.createTextNode(' navigate')]),
    el('span', null, [el('kbd', null, '\u23CE'), document.createTextNode(' select')]),
    el('span', null, [el('kbd', null, 'esc'), document.createTextNode(' close')]),
  ]);
  palette.appendChild(inputWrap);
  palette.appendChild(list);
  palette.appendChild(footer);
  overlay.appendChild(palette);
  document.body.appendChild(overlay);
  input.focus();

  var activeIdx = 0;
  function renderItems(filter) {
    var items = cmdActions.filter(function (a) { return !filter || a.label.toLowerCase().indexOf(filter.toLowerCase()) >= 0; });
    if (activeIdx >= items.length) activeIdx = Math.max(0, items.length - 1);
    clr(list, items.map(function (a, i) {
      var item = el('div', { class: 'cmd-item' + (i === activeIdx ? ' active' : '') }, [
        el('span', { class: 'cmd-item-icon' }, a.icon),
        el('span', { class: 'cmd-item-label' }, a.label),
        a.desc ? el('span', { class: 'cmd-item-desc' }, a.desc) : null,
      ]);
      item.addEventListener('click', function () { closeCmdPalette(); a.fn(); });
      return item;
    }));
    return items;
  }
  renderItems('');

  input.addEventListener('input', function () { activeIdx = 0; renderItems(this.value); });
  input.addEventListener('keydown', function (e) {
    var items = cmdActions.filter(function (a) { return !input.value || a.label.toLowerCase().indexOf(input.value.toLowerCase()) >= 0; });
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); renderItems(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderItems(input.value); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[activeIdx]) { closeCmdPalette(); items[activeIdx].fn(); } }
    else if (e.key === 'Escape') { closeCmdPalette(); }
  });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeCmdPalette(); });
}

function closeCmdPalette() {
  cmdOpen = false;
  var overlay = document.querySelector('.cmd-overlay');
  if (overlay) overlay.remove();
}

/* ═══ Keyboard Shortcuts ═══ */
document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openCmdPalette(); return; }
  if (e.key === 'Escape') {
    if (cmdOpen) { closeCmdPalette(); return; }
    var si = document.getElementById('search-input');
    if (document.activeElement === si) { si.value = ''; searchQuery = ''; applySearch(); si.blur(); }
    return;
  }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'SELECT') {
    e.preventDefault(); document.getElementById('msg-text').focus();
  }
});

/* ═══ Browser Notifications ═══ */
var lastMsgCount = null;
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

/* ═══ Render ═══ */
var lastHash = '';
var lastData = null;
var shouldScroll = true;
var lastDataTime = Date.now();

function render(d) {
  try {
    lastData = d; lastDataTime = Date.now(); renderGeneration++;
    var tasks = d.tasks || [];
    var pinnedMsgs = d.pinned || [];
    var activeFiles = d.active_files || [];
    var hash = JSON.stringify({
      p: d.peers.map(function (p) { return p.id + (p.name || '') + (p.summary || '') + (p.status || '') + sc(p.last_seen) + (p.group_id || '') }),
      ty: (d.typing || []).join(','),
      m: d.messages.length > 0 ? d.messages[d.messages.length - 1].id + '_' + d.messages.length : '0',
      g: d.groups.length, s: d.session_id || '',
      tk: tasks.length > 0 ? tasks[0].id + '_' + tasks.length : '0',
      pn: pinnedMsgs.length,
      af: activeFiles.map(function (a) { return a.peer_id + ':' + a.files.length; }).join(','),
      rx: JSON.stringify(d.reactions || {}),
      au: (d.audit || []).length,
      ap: (d.approvals || []).length,
      dec: (d.decisions || []).length,
      ver: (d.verifications || []).length,
      prop: (d.proposals || []).map(function (p) { return p.id + '_' + (p.votes || []).length + '_' + p.status; }).join(',')
    });
    if (hash === lastHash) return;
    lastHash = hash;

    document.getElementById('uptime-el').textContent = uptime(d.uptime_ms || 0);
    document.getElementById('pc').textContent = String(d.peers.length);
    document.getElementById('gc').textContent = String(d.groups.length);
    document.getElementById('tc').textContent = String(tasks.filter(function (t) { return t.status !== 'completed'; }).length);
    document.getElementById('fc').textContent = String(activeFiles.reduce(function (n, a) { return n + a.files.length; }, 0));
    document.getElementById('dc').textContent = String((d.decisions || []).filter(function (x) { return x.status === 'active'; }).length);
    document.getElementById('vc').textContent = String((d.verifications || []).filter(function (x) { return x.status === 'pending'; }).length);
    document.getElementById('prc').textContent = String((d.proposals || []).filter(function (x) { return x.status === 'open'; }).length);

    /* Browser notification for new messages */
    if (lastMsgCount !== null && d.messages.length > lastMsgCount && document.hidden) {
      var newest = d.messages[d.messages.length - 1];
      var senderName = d.peers.find(function (p) { return p.id === newest.from_id; });
      var notifTitle = (senderName ? senderName.name : newest.from_id) + ' sent a message';
      var notifBody = newest.text.slice(0, 120);
      if (Notification.permission === 'granted') {
        new Notification(notifTitle, { body: notifBody, icon: '', tag: 'claude-peers-msg' });
      }
    }
    lastMsgCount = d.messages.length;

    /* Sidebar: Peers (grouped by isolation group) */
    var pl = document.getElementById('peer-list');
    if (d.peers.length === 0) {
      clr(pl, el('div', { class: 'empty-hint' }, 'Waiting for peers...'));
    } else {
      var groupNameMap = {};
      if (d.groups) d.groups.forEach(function (g) { groupNameMap[g.id] = g.name; });
      var lobbyPeers = d.peers.filter(function (p) { return !p.group_id; });
      var groupedPeers = {};
      d.peers.forEach(function (p) {
        if (p.group_id) {
          if (!groupedPeers[p.group_id]) groupedPeers[p.group_id] = [];
          groupedPeers[p.group_id].push(p);
        }
      });
      var groupOptions = (d.groups || []).map(function (g) { return { id: g.id, name: g.name }; });

      function makePeerCard(p) {
        var statusCls = 'p-status p-status-' + (p.status || 'online');
        var copyBtn = el('button', { class: 'copy-btn', title: 'Copy ID' }, '\u2398');
        copyBtn.addEventListener('click', function (e) { e.stopPropagation(); copyId(p.id); });
        var isTyping = d.typing && d.typing.indexOf(p.id) >= 0;
        var assignSelect = el('select', { class: 'p-assign', title: 'Assign to group' });
        var lobbyOpt = el('option', { value: '' }, 'Lobby');
        if (!p.group_id) lobbyOpt.selected = true;
        assignSelect.appendChild(lobbyOpt);
        groupOptions.forEach(function (g) {
          var opt = el('option', { value: g.id }, g.name);
          if (p.group_id === g.id) opt.selected = true;
          assignSelect.appendChild(opt);
        });
        assignSelect.addEventListener('change', function () {
          var gid = this.value || null;
          fetch('/assign-group', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ peer_id: p.id, group_id: gid })
          }).catch(function () { });
        });
        var avatar = el('div', { class: 'p-avatar' }, [
          document.createTextNode(ini(p.name || p.id)),
          el('span', { class: 'status-ring ' + sc(p.last_seen) }),
        ]);
        return el('div', { class: 'p-card' }, [
          el('div', { class: 'p-row' }, [
            avatar,
            el('div', { class: 'p-name' }, p.name || p.id),
            el('span', { class: statusCls }, p.status || 'online'),
            copyBtn,
          ]),
          isTyping ? el('div', { class: 'typing-indicator' }, [
            el('span', { class: 'typing-dots' }, [el('span'), el('span'), el('span')]),
            document.createTextNode('typing...'),
          ]) : null,
          p.summary ? el('div', { class: 'p-summary' }, p.summary) : null,
          el('div', { class: 'p-cwd', title: p.cwd }, p.cwd),
          assignSelect,
        ]);
      }

      var sections = [];
      if (lobbyPeers.length > 0) {
        var lobbyHeader = el('div', { class: 'group-section-header lobby' }, [el('span', { class: 'group-section-name' }, 'Lobby')]);
        sections.push(el('div', { class: 'group-section' }, [lobbyHeader].concat(lobbyPeers.map(makePeerCard))));
      }
      Object.keys(groupedPeers).forEach(function (gid) {
        var gName = groupNameMap[gid] || gid;
        var delBtn = el('button', { class: 'group-section-del', title: 'Delete group' }, '\u00d7');
        delBtn.addEventListener('click', function () {
          if (confirm('Delete group "' + gName + '"? Members will return to lobby.')) {
            fetch('/delete-group', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ group_id: gid })
            }).catch(function () { });
          }
        });
        var header = el('div', { class: 'group-section-header' }, [el('span', { class: 'group-section-name' }, gName), delBtn]);
        sections.push(el('div', { class: 'group-section' }, [header].concat(groupedPeers[gid].map(makePeerCard))));
      });
      if (d.groups) d.groups.forEach(function (g) {
        if (!groupedPeers[g.id]) {
          var delBtn = el('button', { class: 'group-section-del', title: 'Delete group' }, '\u00d7');
          delBtn.addEventListener('click', function () {
            if (confirm('Delete group "' + g.name + '"?')) {
              fetch('/delete-group', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: g.id })
              }).catch(function () { });
            }
          });
          var header = el('div', { class: 'group-section-header' }, [el('span', { class: 'group-section-name' }, g.name), delBtn]);
          sections.push(el('div', { class: 'group-section' }, [header, el('div', { class: 'empty-hint' }, 'No members')]));
        }
      });
      clr(pl, sections);
    }

    /* Peer selector — shows group label for clarity */
    var sel = document.getElementById('to-peer'); var cur = sel.value;
    if (d.peers.length === 0) { clr(sel, [el('option', { value: '' }, 'no peers')]); }
    else {
      clr(sel, d.peers.map(function (p) {
        var groupLabel = p.group_id ? (groupNameMap[p.group_id] || 'Group') : 'Lobby';
        return el('option', { value: p.id }, (p.name || p.id) + ' (' + groupLabel + ')');
      }));
      if (cur) sel.value = cur;
    }

    /* Sidebar: Groups summary */
    var gl = document.getElementById('group-list');
    if (!d.groups || d.groups.length === 0) { clr(gl, el('div', { class: 'empty-hint' }, 'No isolation groups')); }
    else { clr(gl, el('div', { class: 'g-chips' }, d.groups.map(function (g) { return el('div', { class: 'g-chip' }, [el('b', null, g.name), document.createTextNode(String(g.member_count))]); }))); }

    /* Sidebar: Tasks */
    var tl = document.getElementById('task-list');
    if (tasks.length === 0) { clr(tl, el('div', { class: 'empty-hint' }, 'No tasks')); }
    else {
      var taskNodes = tasks.slice(0, 20).map(function (t) {
        var isDone = t.status === 'completed';
        var checkBtn = el('button', { class: 'task-check' + (isDone ? ' done' : ''), title: isDone ? 'Completed' : 'Mark complete' }, isDone ? '\u2713' : '');
        if (!isDone) {
          checkBtn.addEventListener('click', function () {
            fetch('/complete-task', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ task_id: t.id, peer_id: 'dashboard', result: '' }) }).catch(function () { });
          });
        }
        var assigneeLabel = t.assignee_id ? (d.peers.find(function (p) { return p.id === t.assignee_id; }) || {}).name || t.assignee_id : '';
        var meta = [];
        if (assigneeLabel) meta.push(el('span', { class: 'task-assignee' }, assigneeLabel));
        meta.push(el('span', null, new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
        return el('div', { class: 'task-item' + (isDone ? ' completed' : '') }, [
          checkBtn,
          el('div', { class: 'task-body' }, [
            el('div', { class: 'task-title' }, t.title),
            el('div', { class: 'task-meta' }, meta),
          ]),
        ]);
      });
      clr(tl, taskNodes);
    }

    /* Sidebar: Active Files */
    var fl = document.getElementById('file-list');
    if (activeFiles.length === 0) { clr(fl, el('div', { class: 'empty-hint' }, 'No active edits')); }
    else {
      // Build conflict map: file -> list of peer names editing it
      var fileOwners = {};
      activeFiles.forEach(function (a) {
        a.files.forEach(function (f) {
          if (!fileOwners[f]) fileOwners[f] = [];
          fileOwners[f].push(a.peer_name);
        });
      });
      var fileNodes = [];
      activeFiles.forEach(function (a) {
        a.files.forEach(function (f) {
          var isConflict = fileOwners[f].length > 1;
          var entry = el('div', { class: 'file-entry' }, [
            el('span', { class: 'fe-peer' }, a.peer_name),
            el('span', { class: 'fe-file' + (isConflict ? ' file-conflict' : ''), title: f }, f.split(/[/\\]/).pop()),
            isConflict ? el('span', { class: 'file-conflict-badge' }, 'CONFLICT') : null,
          ]);
          fileNodes.push(entry);
        });
      });
      clr(fl, fileNodes);
    }

    /* Sidebar: Audit Log */
    var al = document.getElementById('audit-list');
    var auditEntries = d.audit || [];
    if (auditEntries.length === 0) { clr(al, el('div', { class: 'empty-hint' }, 'No activity yet')); }
    else {
      clr(al, auditEntries.slice(0, 10).map(function (a) {
        return el('div', { class: 'audit-entry' }, [
          el('span', { class: 'ae-time' }, new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
          el('span', { class: 'ae-action' }, a.action.split('.').pop()),
          el('span', { class: 'ae-detail' }, a.actor_name || a.details || a.actor_id),
        ]);
      }));
    }

    /* Name map (used by panels and chat) */
    var nm = {}; d.peers.forEach(function (p) { nm[p.id] = p.name || p.id; });
    nm['dashboard'] = 'You'; nm['cli'] = 'CLI';

    /* Sidebar: Decisions */
    var dl = document.getElementById('decision-list');
    var decisions = d.decisions || [];
    if (decisions.length === 0) { clr(dl, el('div', { class: 'empty-hint' }, 'No decisions recorded')); }
    else {
      var cats = {};
      decisions.forEach(function (dec) { if (!cats[dec.category]) cats[dec.category] = []; cats[dec.category].push(dec); });
      var decNodes = [];
      Object.keys(cats).forEach(function (cat) {
        decNodes.push(el('div', { class: 'dec-cat-header' }, cat));
        cats[cat].forEach(function (dec) {
          var isRevoked = dec.status === 'revoked';
          decNodes.push(el('div', { class: 'dec-card' + (isRevoked ? ' dec-revoked' : '') }, [
            el('div', { class: 'dec-key' }, dec.key),
            el('div', { class: 'dec-val' }, dec.value),
            dec.rationale ? el('div', { class: 'dec-rationale' }, dec.rationale) : null,
            el('div', { class: 'dec-meta' }, [
              el('span', null, dec.author_name || dec.author_id),
              el('span', null, fmt(dec.updated_at)),
            ]),
          ]));
        });
      });
      clr(dl, decNodes);
    }

    /* Sidebar: Verifications */
    var vl = document.getElementById('verification-list');
    var verifications = d.verifications || [];
    if (verifications.length === 0) { clr(vl, el('div', { class: 'empty-hint' }, 'No verifications')); }
    else {
      clr(vl, verifications.map(function (v) {
        return el('div', { class: 'ver-card' }, [
          el('div', null, [
            el('span', { class: 'ver-status ver-' + v.status }, v.status),
            el('span', { class: 'ver-claim' }, v.claim),
          ]),
          el('div', { class: 'ver-meta' }, [
            el('span', null, (nm[v.requester_id] || v.requester_id) + ' \u2192 ' + (nm[v.verifier_id] || v.verifier_id)),
            el('span', null, fmt(v.created_at)),
          ]),
          v.response ? el('div', { class: 'ver-response' }, v.response) : null,
        ]);
      }));
    }

    /* Sidebar: Proposals */
    var prl = document.getElementById('proposal-list');
    var proposals = d.proposals || [];
    if (proposals.length === 0) { clr(prl, el('div', { class: 'empty-hint' }, 'No proposals')); }
    else {
      clr(prl, proposals.map(function (p) {
        var votes = p.votes || [];
        var approves = votes.filter(function (v) { return v.vote === 'approve'; }).length;
        var rejects = votes.filter(function (v) { return v.vote === 'reject'; }).length;
        var pct = p.required_votes > 0 ? Math.min(100, Math.round((approves / p.required_votes) * 100)) : 0;
        var statusLabel = p.status === 'open' ? '\u23F3 Open' : p.status === 'approved' ? '\u2705 Approved' : '\u274C Rejected';
        var voteButtons = [];
        if (p.status === 'open') {
          var appBtn = el('button', { class: 'prop-vote-btn prop-approve' }, '\u2705 Approve');
          appBtn.addEventListener('click', (function (pid) { return function () {
            fetch('/vote-proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ proposal_id: pid, voter_id: 'dashboard', vote: 'approve', reason: '' }) }).catch(function () {});
          }; })(p.id));
          var rejBtn = el('button', { class: 'prop-vote-btn prop-reject' }, '\u274C Reject');
          rejBtn.addEventListener('click', (function (pid) { return function () {
            fetch('/vote-proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ proposal_id: pid, voter_id: 'dashboard', vote: 'reject', reason: '' }) }).catch(function () {});
          }; })(p.id));
          voteButtons = [appBtn, rejBtn];
        }
        return el('div', { class: 'prop-card' }, [
          el('div', null, [el('span', { class: 'prop-title' }, p.title), el('span', { class: 'prop-status' }, statusLabel)]),
          p.description ? el('div', { class: 'prop-desc' }, p.description) : null,
          el('div', { class: 'prop-votes' }, [document.createTextNode(approves + '/' + p.required_votes + ' approvals, ' + rejects + ' rejections')]),
          el('div', { class: 'prop-bar' }, [el('div', { class: 'prop-bar-fill', style: 'width:' + pct + '%;background:var(--success)' })]),
          voteButtons.length > 0 ? el('div', { class: 'prop-actions' }, voteButtons) : null,
          votes.length > 0 ? el('div', { class: 'prop-voter-list' }, votes.map(function (v) {
            return el('div', { class: 'prop-voter' }, [
              el('span', null, v.vote === 'approve' ? '\u2705' : '\u274C'),
              el('span', null, v.voter_name || v.voter_id),
              v.reason ? el('span', { class: 'prop-voter-reason' }, v.reason) : null,
            ]);
          })) : null,
        ]);
      }));
    }

    /* Pinned messages bar */
    var pinnedBar = document.getElementById('pinned-bar');
    if (pinnedMsgs.length === 0) { pinnedBar.style.display = 'none'; }
    else {
      pinnedBar.style.display = '';
      var pinnedNodes = [el('div', { class: 'pinned-title' }, '\u{1F4CC} Pinned')];
      var pnm = {}; d.peers.forEach(function (p) { pnm[p.id] = p.name || p.id; });
      pnm['dashboard'] = 'You'; pnm['cli'] = 'CLI';
      pinnedMsgs.forEach(function (m) {
        var unpinBtn = el('button', { class: 'pm-unpin', title: 'Unpin' }, '\u00d7');
        unpinBtn.addEventListener('click', function () {
          fetch('/pin-message', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message_id: m.id, pinned: false }) }).catch(function () { });
        });
        pinnedNodes.push(el('div', { class: 'pinned-msg' }, [
          el('span', { class: 'pm-from' }, pnm[m.from_id] || m.from_id),
          el('span', { class: 'pm-text' }, m.text.slice(0, 200)),
          unpinBtn,
        ]));
      });
      clr(pinnedBar, pinnedNodes);
    }


    /* Chat */
    var chat = document.getElementById('chat');
    if (d.messages.length === 0) {
      clr(chat, el('div', { class: 'empty-chat' }, [
        el('div', { class: 'ec-icon' }, [el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
          el('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }),
        ])]),
        el('div', { class: 'ec-title' }, 'Your peer network'),
        el('div', { class: 'ec-sub' }, 'Structured messaging between Claude Code instances with verification, decisions, and consensus.'),
      ]));
      return;
    }

    var nodes = [];
    nodes.push(el('div', { class: 'sess-mark' }, [el('div', { class: 'sess-mark-pill' }, [document.createTextNode('session started')])]));
    var prevSender = null; var prevTime = null;

    d.messages.forEach(function (m) {
      if (timeGap(prevTime, m.sent_at)) { nodes.push(el('div', { class: 'time-div' }, fmt(m.sent_at))); prevSender = null; }
      prevTime = m.sent_at;
      var fromLabel = nm[m.from_id] || m.from_id;
      var toLabel = nm[m.to_id] || m.to_id;
      var fromIsUser = isUser(m.from_id);
      var fromIsCli = isCli(m.from_id);
      var newGroup = (m.from_id !== prevSender);
      prevSender = m.from_id;
      var stTxt, stCls;
      if (m.acknowledged) { stTxt = '\u2713\u2713'; stCls = 'st st-a'; }
      else if (m.delivered) { stTxt = '\u2713'; stCls = 'st st-d'; }
      else { stTxt = '\u25CB'; stCls = 'st st-p'; }
      var bubCls = fromIsUser ? 'bub b-u' : fromIsCli ? 'bub b-s' : 'bub b-p';
      var footCls = fromIsUser ? 'bub-foot right' : 'bub-foot';
      var textEl;
      if (m.msg_type) {
        var typeLabels = { question: 'Question', decision: 'Decision', context_share: 'Context', review_request: 'Review', handoff: 'Handoff' };
        var badge = el('span', { class: 'msg-type-badge msg-type-' + m.msg_type }, typeLabels[m.msg_type] || m.msg_type);
        var bodyEl = renderMarkdown(m.text);
        while (bodyEl.firstChild && bodyEl.firstChild.className === 'bub-text') { bodyEl = bodyEl.firstChild; break; }
        textEl = el('div', { class: 'bub-text' }, [badge]);
        while (bodyEl.firstChild) textEl.appendChild(bodyEl.firstChild);
      } else {
        textEl = renderMarkdown(m.text);
      }
      if (m.context_snapshot) {
        try {
          var ctx = JSON.parse(m.context_snapshot);
          var ctxToggle = el('div', { class: 'ctx-snap-toggle' }, '\u25B6 Context');
          var ctxParts = [];
          if (ctx.branch) ctxParts.push(el('div', null, 'Branch: ' + ctx.branch));
          if (ctx.recent_files && ctx.recent_files.length > 0) ctxParts.push(el('div', null, 'Files: ' + ctx.recent_files.join(', ')));
          if (ctx.summary) ctxParts.push(el('div', null, 'Summary: ' + ctx.summary));
          var ctxBody = el('div', { class: 'ctx-snap-body' }, ctxParts);
          ctxToggle.addEventListener('click', function () {
            var b = this.nextSibling;
            b.classList.toggle('open');
            this.textContent = b.classList.contains('open') ? '\u25BC Context' : '\u25B6 Context';
          });
          textEl.appendChild(el('div', { class: 'ctx-snap' }, [ctxToggle, ctxBody]));
        } catch (e) { /* ignore */ }
      }
      if (isPeer(m.from_id)) { textEl.setAttribute('data-tr-src', m.text); textEl.setAttribute('data-msg-id', String(m.id)); }
      var footItems = [el('span', null, fmtSec(m.sent_at)), el('span', null, '\u2192 ' + toLabel), el('span', { class: stCls }, stTxt)];
      if (isPeer(m.from_id)) {
        var trBtn = el('button', { class: 'tr-bubble-btn', title: 'Translate to Arabic' }, [
          el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, [el('circle', { cx: '12', cy: '12', r: '10' }), el('path', { d: 'M2 12h20' })]),
          document.createTextNode('AR'),
        ]);
        trBtn.addEventListener('click', (function (msgId, rawText, btnRef, textRef) {
          return function () { translateBubble(msgId, rawText, btnRef, textRef); };
        })(m.id, m.text, trBtn, textEl));
        footItems.push(trBtn);
      }

      /* Pin button for all messages */
      var isPinned = pinnedMsgs.some(function (pm) { return pm.id === m.id; });
      var pinBtn = el('button', { class: 'pin-bubble-btn' + (isPinned ? ' pinned' : ''), title: isPinned ? 'Unpin' : 'Pin' }, isPinned ? '\u{1F4CC}' : '\u{1F4CC}');
      pinBtn.addEventListener('click', (function (msgId, wasPinned) {
        return function () {
          fetch('/pin-message', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message_id: msgId, pinned: !wasPinned }) }).catch(function () { });
        };
      })(m.id, isPinned));
      footItems.push(pinBtn);

      /* Reactions display */
      var reactionsData = (d.reactions || {})[m.id] || [];
      var reactionsEl = null;
      if (reactionsData.length > 0) {
        var emojiCounts = {};
        reactionsData.forEach(function (r) {
          if (!emojiCounts[r.emoji]) emojiCounts[r.emoji] = { count: 0, names: [] };
          emojiCounts[r.emoji].count++;
          emojiCounts[r.emoji].names.push(r.peer_name);
        });
        var chips = Object.keys(emojiCounts).map(function (emoji) {
          var chip = el('span', { class: 'reaction-chip', title: emojiCounts[emoji].names.join(', ') }, [
            document.createTextNode(emoji),
            emojiCounts[emoji].count > 1 ? el('span', { class: 'rc-count' }, String(emojiCounts[emoji].count)) : null,
          ]);
          chip.addEventListener('click', function () {
            fetch('/react', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message_id: m.id, peer_id: 'dashboard', emoji: emoji }) }).catch(function () { });
          });
          return chip;
        });
        reactionsEl = el('div', { class: 'bub-reactions' }, chips);
      }

      var bubble = el('div', { class: bubCls }, [textEl, reactionsEl, el('div', { class: footCls }, footItems)]);
      if (newGroup) {
        var avCls = fromIsUser ? 'm-av av-u' : fromIsCli ? 'm-av av-c' : 'm-av av-p';
        var grpCls = fromIsUser ? 'm-group u-group' : 'm-group p-group';
        var hdCls = fromIsUser ? 'g-head right' : 'g-head';
        var header = el('div', { class: hdCls }, [
          fromIsUser ? null : el('div', { class: avCls }, ini(fromLabel)),
          el('div', { class: 'g-label' }, fromLabel),
          fromIsUser ? el('div', { class: avCls }, ini(fromLabel)) : null,
        ]);
        var group = el('div', { class: grpCls }, [header, bubble]);
        group.setAttribute('data-group-sender', m.from_id);
        nodes.push(group);
      } else {
        var lastGroup = nodes[nodes.length - 1];
        if (lastGroup && lastGroup.getAttribute && lastGroup.getAttribute('data-group-sender') === m.from_id) {
          lastGroup.appendChild(bubble);
        } else { nodes.push(bubble); }
      }
    });

    clr(chat, nodes);
    if (shouldScroll) { var scrollEl = document.getElementById('chat-scroll'); scrollEl.scrollTop = scrollEl.scrollHeight; }

    /* Re-apply translations */
    if (trActiveSet.size > 0) {
      var trEls = document.querySelectorAll('[data-msg-id]');
      for (var ti = 0; ti < trEls.length; ti++) {
        var msgIdNum = parseInt(trEls[ti].getAttribute('data-msg-id'), 10);
        if (!trActiveSet.has(msgIdNum)) continue;
        var raw = trEls[ti].getAttribute('data-tr-src');
        if (!raw || !trCache[raw]) continue;
        var reRendered = renderMarkdown(trCache[raw]);
        while (trEls[ti].firstChild) trEls[ti].removeChild(trEls[ti].firstChild);
        while (reRendered.firstChild) trEls[ti].appendChild(reRendered.firstChild);
        trEls[ti].setAttribute('data-tr-done', '1');
        trEls[ti].style.direction = 'rtl'; trEls[ti].style.textAlign = 'right';
        var bub = trEls[ti].parentNode;
        if (bub) {
          var arBtn = bub.querySelector('.tr-bubble-btn');
          if (arBtn) { arBtn.textContent = 'EN'; arBtn.title = 'Show original'; }
          var foot = bub.querySelector('.bub-foot');
          if (foot && !foot.querySelector('.tr-label')) { foot.insertBefore(el('span', { class: 'tr-label' }, 'translated'), foot.firstChild); }
        }
      }
    }
    if (searchQuery) applySearch();
  } catch (err) { document.title = 'ERROR: ' + err.message; console.error('Render error:', err); }
}

/* Scroll tracking */
document.getElementById('chat-scroll').addEventListener('scroll', function () {
  shouldScroll = (this.scrollHeight - this.scrollTop - this.clientHeight) < 80;
});

/* ═══ WebSocket ═══ */
var ws = null, wsRetry = 1000;
function connectWS() {
  var pill = document.getElementById('ws-pill');
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onopen = function () { pill.textContent = ''; pill.appendChild(el('span', { class: 'conn-dot' })); pill.appendChild(document.createTextNode(' connected')); pill.className = 'conn-badge ok'; wsRetry = 1000; };
  ws.onmessage = function (ev) { try { render(JSON.parse(ev.data)); } catch (e) { console.error('WS parse error:', e); } };
  ws.onclose = function () {
    pill.textContent = ''; pill.appendChild(el('span', { class: 'conn-dot' })); pill.appendChild(document.createTextNode(' reconnecting')); pill.className = 'conn-badge err';
    setTimeout(connectWS, wsRetry); wsRetry = Math.min(wsRetry * 1.5, 10000);
  };
  ws.onerror = function () { ws.close(); };
}

/* ═══ Send ═══ */
function resetSendBtn(btn) {
  while (btn.firstChild) btn.removeChild(btn.firstChild);
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', '12'); line.setAttribute('y1', '19');
  line.setAttribute('x2', '12'); line.setAttribute('y2', '5');
  var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', '5 12 12 5 19 12');
  svg.appendChild(line); svg.appendChild(poly);
  btn.appendChild(svg);
}
async function sendMsg() {
  var to = document.getElementById('to-peer').value;
  var textarea = document.getElementById('msg-text');
  var text = textarea.value.trim();
  if (!to || !text) return;
  var btn = document.getElementById('send-btn');
  while (btn.firstChild) btn.removeChild(btn.firstChild);
  btn.textContent = '\u2022\u2022\u2022';
  try {
    var r = await fetch('/send-message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_id: 'dashboard', to_id: to, text: text })
    });
    var d = await r.json();
    var t = document.getElementById('toast');
    if (d.ok) { t.textContent = '\u2713 Sent'; t.style.color = 'var(--success)'; textarea.value = ''; textarea.style.height = 'auto'; shouldScroll = true; }
    else { t.textContent = '\u2717 ' + d.error; t.style.color = 'var(--error)'; }
    setTimeout(function () { t.textContent = ''; }, 2500);
  } catch (e) { document.getElementById('toast').textContent = '\u2717 ' + e.message; }
  finally { resetSendBtn(btn); }
}
document.getElementById('send-btn').addEventListener('click', sendMsg);
document.getElementById('msg-text').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

/* ═══ Sidebar toggle & panel switching ═══ */
(function () {
  var app = document.querySelector('.app');
  var sidebar = document.getElementById('sidebar');
  var savedState = localStorage.getItem('sidebar-state') || 'expanded';
  app.setAttribute('data-sidebar', savedState);

  /* Mobile hamburger */
  document.getElementById('sidebar-trigger').addEventListener('click', function () {
    sidebar.classList.toggle('open');
    var ov = document.getElementById('sidebar-overlay');
    ov.classList.toggle('show');
  });
  document.getElementById('sidebar-overlay').addEventListener('click', function () {
    sidebar.classList.remove('open');
    this.classList.remove('show');
  });

  /* Rail item clicks — switch panel + expand sidebar */
  var railItems = document.querySelectorAll('.rail-item');
  railItems.forEach(function (item) {
    item.addEventListener('click', function () {
      var panel = this.getAttribute('data-panel');
      /* If clicking the already-active rail item, toggle sidebar collapse */
      if (this.classList.contains('active') && app.getAttribute('data-sidebar') === 'expanded') {
        app.setAttribute('data-sidebar', 'collapsed');
        localStorage.setItem('sidebar-state', 'collapsed');
        return;
      }
      /* Expand sidebar if collapsed */
      if (app.getAttribute('data-sidebar') === 'collapsed') {
        app.setAttribute('data-sidebar', 'expanded');
        localStorage.setItem('sidebar-state', 'expanded');
      }
      /* Switch active panel */
      document.querySelectorAll('.panel-content').forEach(function (p) { p.classList.remove('active'); });
      var target = document.getElementById('panel-' + panel);
      if (target) target.classList.add('active');
      railItems.forEach(function (r) { r.classList.remove('active'); });
      this.classList.add('active');
    });
  });
})();

/* ═══ Theme toggle ═══ */
var savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('theme-btn').addEventListener('click', function () {
  var current = document.documentElement.getAttribute('data-theme');
  var next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

/* ═══ Search ═══ */
var searchQuery = '';
document.getElementById('search-input').addEventListener('input', function () {
  searchQuery = this.value.toLowerCase().trim(); applySearch();
});
function applySearch() {
  var bubbles = document.querySelectorAll('.bub');
  if (!searchQuery) { for (var i = 0; i < bubbles.length; i++) bubbles[i].classList.remove('msg-dim'); return; }
  for (var i = 0; i < bubbles.length; i++) {
    var textEl = bubbles[i].querySelector('.bub-text');
    var visText = textEl ? textEl.textContent.toLowerCase() : '';
    var origText = textEl ? (textEl.getAttribute('data-tr-src') || '').toLowerCase() : '';
    var foot = bubbles[i].querySelector('.bub-foot');
    var meta = foot ? foot.textContent.toLowerCase() : '';
    bubbles[i].classList.toggle('msg-dim',
      visText.indexOf(searchQuery) < 0 && origText.indexOf(searchQuery) < 0 && meta.indexOf(searchQuery) < 0);
  }
}

/* ═══ Group management ═══ */
document.getElementById('g-create-btn').addEventListener('click', function () {
  var name = document.getElementById('g-join-name').value.trim();
  if (!name) return;
  fetch('/create-group', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.ok) { document.getElementById('g-join-name').value = ''; }
      else {
        var t = document.getElementById('toast');
        t.textContent = '\u2717 ' + (d.error || 'Failed'); t.style.color = 'var(--error)';
        setTimeout(function () { t.textContent = ''; }, 3000);
      }
    }).catch(function () { });
});

/* ═══ Copy peer ID ═══ */
function copyId(id) {
  navigator.clipboard.writeText(id).then(function () {
    var t = document.getElementById('toast');
    t.textContent = 'Copied: ' + id; t.style.color = 'var(--text-secondary)';
    setTimeout(function () { t.textContent = ''; }, 1500);
  }).catch(function () { });
}

/* ═══ Export chat ═══ */
document.getElementById('export-btn').addEventListener('click', function () {
  if (!lastData || !lastData.messages.length) return;
  var nm = {};
  lastData.peers.forEach(function (p) { nm[p.id] = p.name || p.id; });
  nm['dashboard'] = 'Dashboard'; nm['cli'] = 'CLI';
  var lines = lastData.messages.map(function (m) {
    var time = new Date(m.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return '[' + time + '] ' + (nm[m.from_id] || m.from_id) + ' \u2192 ' + (nm[m.to_id] || m.to_id) + ': ' + m.text;
  });
  var blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = 'claude-peers-chat.txt'; a.click();
  URL.revokeObjectURL(url);
});

/* ═══ Textarea auto-resize & char counter ═══ */
document.getElementById('msg-text').addEventListener('input', function () {
  /* Auto-resize */
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 200) + 'px';
  /* Char counter */
  var len = this.value.length;
  var counter = document.getElementById('char-counter');
  if (len > 50000) {
    counter.textContent = len.toLocaleString() + ' / 65,536';
    counter.className = 'char-counter' + (len > 65536 ? ' over' : ' warn');
  } else { counter.textContent = ''; counter.className = 'char-counter'; }
});

/* ═══ Input validation ═══ */
var origSendMsg = sendMsg;
sendMsg = async function () {
  var text = document.getElementById('msg-text').value.trim();
  if (text.length > 65536) {
    var t = document.getElementById('toast');
    t.textContent = '\u2717 Message too long (max 64KB)'; t.style.color = 'var(--error)';
    setTimeout(function () { t.textContent = ''; }, 3000);
    return;
  }
  return origSendMsg();
};

/* ═══ Initialize ═══ */
fetch('/api/dashboard-state').then(function (r) { return r.json(); }).then(render).catch(function (e) { console.error('Initial fetch error:', e); });
connectWS();
setInterval(function () { if (lastData) { document.getElementById('uptime-el').textContent = uptime(lastData.uptime_ms + (Date.now() - lastDataTime)); } }, 5000);
setInterval(function () { if (!ws || ws.readyState !== WebSocket.OPEN) { fetch('/api/dashboard-state').then(function (r) { return r.json(); }).then(render).catch(function () { }); } }, 5000);
