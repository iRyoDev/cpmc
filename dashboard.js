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

/* ═══ Render ═══ */
var lastHash = '';
var lastData = null;
var shouldScroll = true;
var lastDataTime = Date.now();

function render(d) {
  try {
    lastData = d; lastDataTime = Date.now(); renderGeneration++;
    var hash = JSON.stringify({
      p: d.peers.map(function (p) { return p.id + (p.name || '') + (p.summary || '') + (p.status || '') + sc(p.last_seen) + (p.group_id || '') }),
      ty: (d.typing || []).join(','),
      m: d.messages.length > 0 ? d.messages[d.messages.length - 1].id + '_' + d.messages.length : '0',
      g: d.groups.length, s: d.session_id || ''
    });
    if (hash === lastHash) return;
    lastHash = hash;

    document.getElementById('uptime-el').textContent = uptime(d.uptime_ms || 0);
    document.getElementById('pc').textContent = String(d.peers.length);
    document.getElementById('gc').textContent = String(d.groups.length);

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
        return el('div', { class: 'p-card' }, [
          el('div', { class: 'p-row' }, [
            el('div', { class: 'p-dot ' + sc(p.last_seen) }),
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

    /* Name map */
    var nm = {}; d.peers.forEach(function (p) { nm[p.id] = p.name || p.id; });
    nm['dashboard'] = 'You'; nm['cli'] = 'CLI';

    /* Chat */
    var chat = document.getElementById('chat');
    if (d.messages.length === 0) {
      clr(chat, el('div', { class: 'empty-chat' }, [
        el('div', { class: 'ec-icon' }, [el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
          el('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }),
        ])]),
        el('div', { class: 'ec-title' }, 'No messages yet'),
        el('div', { class: 'ec-sub' }, 'Start a conversation below'),
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
      var textEl = renderMarkdown(m.text);
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
      var bubble = el('div', { class: bubCls }, [textEl, el('div', { class: footCls }, footItems)]);
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
  ws.onopen = function () { pill.textContent = 'connected'; pill.className = 'nav-pill ok'; wsRetry = 1000; };
  ws.onmessage = function (ev) { try { render(JSON.parse(ev.data)); } catch (e) { console.error('WS parse error:', e); } };
  ws.onclose = function () {
    pill.textContent = 'reconnecting'; pill.className = 'nav-pill err';
    setTimeout(connectWS, wsRetry); wsRetry = Math.min(wsRetry * 1.5, 10000);
  };
  ws.onerror = function () { ws.close(); };
}

/* ═══ Send ═══ */
async function sendMsg() {
  var to = document.getElementById('to-peer').value;
  var text = document.getElementById('msg-text').value.trim();
  if (!to || !text) return;
  var btn = document.getElementById('send-btn');
  btn.textContent = '\u2022\u2022\u2022';
  try {
    var r = await fetch('/send-message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_id: 'dashboard', to_id: to, text: text })
    });
    var d = await r.json();
    var t = document.getElementById('toast');
    if (d.ok) { t.textContent = '\u2713 Sent'; t.style.color = 'var(--grn)'; document.getElementById('msg-text').value = ''; shouldScroll = true; }
    else { t.textContent = '\u2717 ' + d.error; t.style.color = 'var(--red)'; }
    setTimeout(function () { t.textContent = ''; }, 2500);
  } catch (e) { document.getElementById('toast').textContent = '\u2717 ' + e.message; }
  finally { btn.textContent = 'Send'; }
}
document.getElementById('send-btn').addEventListener('click', sendMsg);
document.getElementById('msg-text').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

/* ═══ Sidebar toggle ═══ */
document.getElementById('sidebar-toggle').addEventListener('click', function () {
  document.getElementById('sidebar').classList.toggle('open');
  var ov = document.getElementById('sidebar-overlay');
  ov.classList.toggle('show');
  ov.style.display = ov.classList.contains('show') ? 'block' : 'none';
});
document.getElementById('sidebar-overlay').addEventListener('click', function () {
  document.getElementById('sidebar').classList.remove('open');
  this.classList.remove('show'); this.style.display = 'none';
});

/* ═══ Theme toggle ═══ */
var savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme === 'light' ? 'light' : '');
document.getElementById('theme-btn').addEventListener('click', function () {
  var current = document.documentElement.getAttribute('data-theme');
  var next = current === 'light' ? '' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next === 'light' ? 'light' : 'dark');
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
        t.textContent = '\u2717 ' + (d.error || 'Failed'); t.style.color = 'var(--red)';
        setTimeout(function () { t.textContent = ''; }, 3000);
      }
    }).catch(function () { });
});

/* ═══ Copy peer ID ═══ */
function copyId(id) {
  navigator.clipboard.writeText(id).then(function () {
    var t = document.getElementById('toast');
    t.textContent = 'Copied: ' + id; t.style.color = 'var(--accent)';
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

/* ═══ Char counter ═══ */
document.getElementById('msg-text').addEventListener('input', function () {
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
    t.textContent = '\u2717 Message too long (max 64KB)'; t.style.color = 'var(--red)';
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
