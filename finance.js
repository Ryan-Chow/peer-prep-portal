// Peer Prep Academy — the admin Finance tab.
//
// One React component, PpaFinance, rendered by index.html into the
// {{financeEl}} hole. It reads db.finance (the admin-only cache in db.js) and
// keeps its own view state — date range, sub-tab, selection, open forms — in
// hooks, because none of that needs to survive leaving the tab.
//
// Money is integer cents. db.finance.parseMoney / fmtMoney are the only
// conversions; every input here goes through them.
(function () {
  if (window.PpaFinance) return;

  const R = window.React;
  const h = R.createElement;
  const useState = R.useState, useEffect = R.useEffect, useMemo = R.useMemo, useRef = R.useRef;

  const PREPAY = 'package prepayment';
  const isPrepay = (e) => e.kind === 'income' && e.category.trim().toLowerCase() === PREPAY;
  const isRefund = (e) => e.kind === 'expense' && e.category.trim().toLowerCase() === 'refund';
  // A session counts as revenue while someone owes or paid for it.
  const earns = (f) => f.payment === 'unpaid' || f.payment === 'paid';

  const COLORS = { revenue: '#2a78d6', costs: '#eb6834', net: 'var(--color-text)' };

  const pad2 = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const today = () => isoOf(new Date());
  const monthKey = (iso) => iso.slice(0, 7);
  const monthLabel = (key, withYear) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', withYear ? { month: 'short', year: 'numeric' } : { month: 'short' });
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const hours = (min) => (Math.round(min / 6) / 10).toFixed(1);
  const pct = (num, den) => (den ? Math.round(1000 * num / den) / 10 + '%' : '—');
  const sum = (list, fn) => list.reduce((t, x) => t + (fn(x) || 0), 0);

  // ---- date range -----------------------------------------------------------

  const PRESETS = [
    ['month', 'This month'], ['lastMonth', 'Last month'], ['quarter', 'This quarter'],
    ['ytd', 'Year to date'], ['all', 'All time'], ['custom', 'Custom']
  ];
  function presetRange(id) {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth();
    const end = (yy, mm) => isoOf(new Date(yy, mm + 1, 0));
    if (id === 'month') return { from: isoOf(new Date(y, m, 1)), to: end(y, m) };
    if (id === 'lastMonth') return { from: isoOf(new Date(y, m - 1, 1)), to: end(y, m - 1) };
    if (id === 'quarter') { const q = Math.floor(m / 3) * 3; return { from: isoOf(new Date(y, q, 1)), to: end(y, q + 2) }; }
    if (id === 'ytd') return { from: y + '-01-01', to: today() };
    return { from: '', to: '' };
  }
  const inRange = (range) => (iso) => !!iso && (!range.from || iso >= range.from) && (!range.to || iso <= range.to);

  // ---- CSV and ZIP ----------------------------------------------------------

  // RFC 4180 with a BOM, the same shape index.html's downloadCsv writes.
  const csvText = (rows) => '﻿' + rows.map((r) => r.map((x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const dollars = (c) => (c / 100).toFixed(2);

  function save(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const saveCsv = (name, rows) => save(name, new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' }));

  // A stored (uncompressed) ZIP. CSVs are small and every unzip tool reads
  // method 0, so a deflate library would be weight for nothing.
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (bytes) => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zipBlob(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4],
        [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
        .forEach(([o, v, n]) => (n === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
      const cen = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4],
        [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
        .forEach(([o, v, n]) => (n === 4 ? cen.setUint32(o, v, true) : cen.setUint16(o, v, true)));
      parts.push(local, name, data);
      central.push(cen, name);
      offset += 30 + name.length + data.length;
    });
    const size = central.reduce((t, p) => t + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }

  // ---- small pieces ---------------------------------------------------------

  // An amount typed as dollars, committed on blur or Enter. Esc puts it back.
  function MoneyInput(props) {
    const fmt = (c) => (c == null ? '' : (c / 100).toFixed(2));
    const [val, setVal] = useState(fmt(props.cents));
    const [bad, setBad] = useState(false);
    useEffect(() => { setVal(fmt(props.cents)); setBad(false); }, [props.cents]);
    const commit = () => {
      if (val === fmt(props.cents)) return;
      const c = window.db.finance.parseMoney(val);
      if (isNaN(c)) { setBad(true); return; }
      setBad(false);
      props.onCommit(c);
    };
    return h('input', {
      className: 'input fin-money', 'aria-label': props.label, inputMode: 'decimal', value: val,
      title: bad ? 'Enter an amount like 45 or 45.00' : undefined,
      style: bad ? { borderColor: '#8c1d18' } : undefined,
      onChange: (e) => setVal(e.target.value),
      onBlur: commit,
      onKeyDown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { setVal(fmt(props.cents)); setBad(false); }
      }
    });
  }

  const Select = (props) => h('select', {
    className: 'input', value: props.value, 'aria-label': props.label, style: props.style,
    onChange: (e) => props.onChange(e.target.value)
  }, props.options.map(([v, l]) => h('option', { key: v, value: v }, l)));

  const Btn = (props) => {
    const p = Object.assign({ type: 'button' }, props, { className: 'btn ' + (props.kind || 'btn-secondary') + ' fin-btn' });
    delete p.kind;
    return h('button', p);
  };

  const Tag = (props) => h('span', { className: 'tag fin-tag fin-tag-' + props.tone, title: props.title }, props.children);

  const STATUS_TONE = { unpaid: 'warn', paid: 'good', waived: 'muted', comped: 'muted', owed: 'warn' };
  const LABEL = { unpaid: 'Unpaid', paid: 'Paid', waived: 'Waived', comped: 'Comped', owed: 'Owed' };

  function Table(props) {
    return h('div', { className: 'fin-table-wrap' },
      h('table', { className: 'table fin-table' },
        h('thead', null, h('tr', null, props.head.map((c, i) => h('th', { key: i, className: c.num ? 'num' : undefined }, c.label)))),
        h('tbody', null, props.children),
        props.foot ? h('tfoot', null, props.foot) : null));
  }

  // ---- chart ----------------------------------------------------------------

  // Revenue and costs as paired bars per month, net as a line on the same
  // dollar axis. Hovering a month shows its three values.
  function MonthChart(props) {
    const months = props.months;
    const [hover, setHover] = useState(-1);
    if (!months.length) return h('p', { className: 'fin-muted' }, 'Nothing in this range yet.');
    const W = 760, H = 260, L = 64, Rt = 12, T = 12, B = 28;
    const maxV = Math.max(1, ...months.map((m) => Math.max(m.revenue, m.costs, m.net)));
    const minV = Math.min(0, ...months.map((m) => m.net));
    const span = maxV - minV;
    const step = niceStep(span / 4);
    const top = Math.ceil(maxV / step) * step, bottom = Math.floor(minV / step) * step;
    const y = (v) => T + (top - v) / (top - bottom) * (H - T - B);
    const slot = (W - L - Rt) / months.length;
    const bw = Math.max(3, Math.min(28, (slot - 10) / 2));
    const x0 = (i) => L + i * slot + slot / 2;
    const ticks = [];
    for (let v = bottom; v <= top + 1; v += step) ticks.push(v);
    const money = window.db.finance.fmtMoney;
    // Rounded 4px at the data end, square at the baseline.
    const bar = (x, v, w, color, key) => {
      const y0 = y(0), y1 = y(v), r = Math.min(4, Math.abs(y0 - y1), w / 2);
      if (Math.abs(y0 - y1) < 0.5) return null;
      const up = v >= 0;
      const d = up
        ? `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`
        : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
      return h('path', { key: key, d: d, fill: color });
    };
    const labelEvery = Math.ceil(months.length / 12);
    const netPts = months.map((m, i) => [x0(i), y(m.net)]);
    const hm = hover >= 0 ? months[hover] : null;
    return h('div', { className: 'fin-chart' },
      h('div', { className: 'fin-legend' },
        h('span', null, h('i', { style: { background: COLORS.revenue } }), 'Revenue'),
        h('span', null, h('i', { style: { background: COLORS.costs } }), 'Costs'),
        h('span', null, h('i', { className: 'line' }), 'Net')),
      h('div', { style: { position: 'relative' } },
        h('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Monthly revenue, costs and net profit', onMouseLeave: () => setHover(-1) },
          ticks.map((v) => h('g', { key: 't' + v },
            h('line', { x1: L, x2: W - Rt, y1: y(v), y2: y(v), stroke: 'var(--color-divider)', strokeWidth: v === 0 ? 1.2 : 0.6 }),
            h('text', { x: L - 8, y: y(v) + 4, textAnchor: 'end', fontSize: 11, fill: 'currentColor', opacity: 0.6 }, money(v, { whole: true })))),
          months.map((m, i) => h('g', { key: m.key },
            bar(x0(i) - bw - 1, m.revenue, bw, COLORS.revenue, 'r'),
            bar(x0(i) + 1, m.costs, bw, COLORS.costs, 'c'),
            i % labelEvery === 0 ? h('text', { x: x0(i), y: H - 8, textAnchor: 'middle', fontSize: 11, fill: 'currentColor', opacity: 0.6 }, monthLabel(m.key, months.length > 12 || i === 0)) : null)),
          h('polyline', { points: netPts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: COLORS.net, strokeWidth: 2, strokeLinejoin: 'round' }),
          netPts.map((p, i) => h('circle', { key: 'n' + i, cx: p[0], cy: p[1], r: 4, fill: COLORS.net, stroke: 'var(--color-bg)', strokeWidth: 2 })),
          hover >= 0 ? h('line', { x1: x0(hover), x2: x0(hover), y1: T, y2: H - B, stroke: 'currentColor', opacity: 0.25 }) : null,
          months.map((m, i) => h('rect', {
            key: 'hit' + i, x: L + i * slot, y: T, width: slot, height: H - T - B, fill: 'transparent',
            onMouseEnter: () => setHover(i), onFocus: () => setHover(i), tabIndex: 0
          }))),
        hm ? h('div', {
          className: 'fin-tip',
          style: { left: Math.min(78, Math.max(4, (x0(hover) / W) * 100)) + '%' }
        },
          h('div', { className: 'fin-tip-title' }, monthLabel(hm.key, true)),
          h('div', null, h('i', { style: { background: COLORS.revenue } }), 'Revenue ', h('b', null, money(hm.revenue))),
          h('div', null, h('i', { style: { background: COLORS.costs } }), 'Costs ', h('b', null, money(hm.costs))),
          h('div', null, h('i', { className: 'line' }), 'Net ', h('b', null, money(hm.net)))) : null));
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 100;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  // ---- statement (print to PDF) --------------------------------------------

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function printStatement(st) {
    const money = window.db.finance.fmtMoney;
    const rowsHtml = st.lines.map((l) => '<tr><td>' + esc(fmtDate(l.date)) + '</td><td>' + esc(l.what) + '</td><td>' + esc(l.status) +
      '</td><td class="n">' + esc(l.amount == null ? '' : money(l.amount)) + '</td></tr>').join('');
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc('Statement — ' + st.name) + '</title><style>' +
      'body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1d1f20;margin:40px}' +
      'h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#5d5d60}table{width:100%;border-collapse:collapse;margin-top:12px}' +
      'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #d4d4d7}th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#5d5d60}' +
      '.n{text-align:right;font-variant-numeric:tabular-nums}.tot td{font-weight:700;border-bottom:none}' +
      '@media print{body{margin:16mm}}</style></head><body>' +
      '<h1>Peer Prep Academy — statement</h1><p>' + esc(st.name) + ' · ' + esc(st.period) + ' · issued ' + esc(fmtDate(today())) + '</p>' +
      '<table><thead><tr><th>Date</th><th>Item</th><th>Status</th><th class="n">Amount</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      '<table>' + st.totals.map(([k, v]) => '<tr class="tot"><td>' + esc(k) + '</td><td class="n">' + esc(money(v)) + '</td></tr>').join('') + '</table>' +
      '<script>window.onload=function(){window.print()}<\/script></body></html>';
    const w = window.open('', '_blank');
    if (!w) { alert('Allow pop-ups for this site to print the statement.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  // ---- the tab --------------------------------------------------------------

  function PpaFinance(props) {
    const db = window.db, F = db.finance, money = F.fmtMoney;
    const [preset, setPreset] = useState('month');
    const [custom, setCustom] = useState(presetRange('month'));
    const [tab, setTab] = useState('overview');
    const [detail, setDetail] = useState(null); // { kind: 'student' | 'tutor', id }
    const [refreshing, setRefreshing] = useState(true);

    // Tutors complete sessions from their own browsers, and the trigger prices
    // them server-side, so coming to this tab rereads the finance tables.
    useEffect(() => { F.reload().finally(() => setRefreshing(false)); }, []);

    const range = preset === 'custom' ? custom : presetRange(preset);
    const inR = inRange(range);
    const users = db.getUsers();
    const nameOf = (id) => { const u = id && db.getUser(id); return u ? u.name : (id ? 'Deleted user' : '—'); };

    if (!F.ready()) {
      return h('div', { className: 'card blueprint fin-card' },
        h('div', { className: 'card-title' }, refreshing ? 'Loading finance…' : 'Finance is not set up yet'),
        refreshing ? null : h('p', { className: 'fin-muted' },
          'Run migrations/012_finance.sql in the Supabase SQL editor, then reload. ', F.error() ? '(' + F.error() + ')' : ''));
    }

    const all = F.rows(), ledgerAll = F.ledger();
    const rows = all.filter((f) => inR(f.date));
    const ledger = ledgerAll.filter((e) => inR(e.date));
    const periodText = range.from || range.to ? fmtDate(range.from) + ' – ' + fmtDate(range.to) : 'All time';

    const totals = (fs, es) => {
      const sessionRevenue = sum(fs.filter(earns), (f) => f.billed);
      const otherIncome = sum(es.filter((e) => e.kind === 'income' && !isPrepay(e)), (e) => e.amount);
      const payouts = sum(fs, (f) => f.tutorPay);
      const otherExpenses = sum(fs, (f) => f.extra) + sum(es.filter((e) => e.kind === 'expense'), (e) => e.amount);
      const revenue = sessionRevenue + otherIncome;
      return { sessionRevenue, otherIncome, revenue, payouts, otherExpenses, net: revenue - payouts - otherExpenses };
    };
    const T = totals(rows, ledger);
    const unpaid = sum(rows.filter((f) => f.payment === 'unpaid'), (f) => f.billed);
    const owed = sum(rows.filter((f) => f.payout === 'owed'), (f) => f.tutorPay);

    const activeTutees = users.filter((u) => u.role === 'student' && u.active);
    const activeTutors = users.filter((u) => u.role === 'tutor' && u.active);
    const missingTutees = activeTutees.filter((u) => !F.rates('tutee', u.id).length);
    const missingTutors = activeTutors.filter((u) => !F.rates('tutor', u.id).length);
    const missing = missingTutees.length + missingTutors.length;

    const kpis = [
      ['Revenue', money(T.revenue), 'Billed on unpaid and paid sessions, plus other income. Package prepayments are not counted twice: the sessions they cover are.'],
      ['Tutor payouts', money(T.payouts)],
      ['Other expenses', money(T.otherExpenses), 'Ledger expenses plus extra costs on sessions.'],
      ['Net profit', money(T.net)],
      ['Margin', pct(T.net, T.revenue)],
      ['Unpaid by students', money(unpaid)],
      ['Owed to tutors', money(owed)],
      ['Sessions', String(rows.length)],
      ['Avg revenue / session', rows.length ? money(Math.round(T.sessionRevenue / rows.length)) : '—']
    ];

    const exportAll = () => {
      const files = [
        { name: 'sessions.csv', text: csvText(sessionCsv(all, nameOf)) },
        { name: 'ledger.csv', text: csvText(ledgerCsv(ledgerAll, nameOf)) },
        { name: 'tutee_rates.csv', text: csvText(rateCsv('tutee', users.filter((u) => u.role === 'student'), F)) },
        { name: 'tutor_rates.csv', text: csvText(rateCsv('tutor', users.filter((u) => u.role === 'tutor'), F)) },
        { name: 'by_student.csv', text: csvText(byStudentCsv(byStudent(users, all, ledgerAll, all, ledgerAll))) },
        { name: 'by_tutor.csv', text: csvText(byTutorCsv(byTutor(users, all))) }
      ];
      save('peer-prep-finance-' + today() + '.zip', zipBlob(files));
    };

    const ctx = { F, db, money, nameOf, users, rows, all, ledger, ledgerAll, range, periodText, setTab, setDetail, inR };

    const tabs = [['overview', 'Overview'], ['sessions', 'Sessions'], ['ledger', 'Ledger'], ['students', 'By Student'], ['tutors', 'By Tutor'], ['rates', 'Rates']];
    const body = detail && detail.kind === 'student' ? h(Statement, Object.assign({ tuteeId: detail.id }, ctx))
      : detail && detail.kind === 'tutor' ? h(Payout, Object.assign({ tutorId: detail.id }, ctx))
      : tab === 'overview' ? h(Overview, ctx)
      : tab === 'sessions' ? h(SessionsTab, ctx)
      : tab === 'ledger' ? h(LedgerTab, ctx)
      : tab === 'students' ? h(StudentsTab, ctx)
      : tab === 'tutors' ? h(TutorsTab, ctx)
      : h(RatesTab, Object.assign({ missingTutees, missingTutors }, ctx));

    return h('div', { className: 'fin' },
      h('div', { className: 'fin-head' },
        h('div', { className: 'fin-range', role: 'group', 'aria-label': 'Date range' },
          PRESETS.map(([id, label]) => h('button', {
            key: id, type: 'button', className: 'btn fin-seg' + (preset === id ? ' on' : ''), 'aria-pressed': preset === id,
            onClick: () => { if (id === 'custom') setCustom(range); setPreset(id); }
          }, label)),
          preset === 'custom' ? h('span', { className: 'fin-custom' },
            h('input', { className: 'input', type: 'date', 'aria-label': 'From', value: custom.from, onChange: (e) => setCustom({ from: e.target.value, to: custom.to }) }),
            h('span', null, 'to'),
            h('input', { className: 'input', type: 'date', 'aria-label': 'To', value: custom.to, onChange: (e) => setCustom({ from: custom.from, to: e.target.value }) })) : null),
        h(Btn, { onClick: exportAll }, 'Export all finance data')),
      missing ? h('div', { className: 'fin-banner' },
        h('span', null, (missingTutees.length ? missingTutees.length + (missingTutees.length === 1 ? ' active tutee' : ' active tutees') : '') +
          (missingTutees.length && missingTutors.length ? ' and ' : '') +
          (missingTutors.length ? missingTutors.length + (missingTutors.length === 1 ? ' active tutor' : ' active tutors') : '') +
          ' ha' + (missing === 1 ? 's' : 've') + ' no rate. Completed sessions for them are priced at $0 until one is set.'),
        h(Btn, { kind: 'btn-primary', onClick: () => { setDetail(null); setTab('rates'); } }, 'Set rates')) : null,
      h('div', { className: 'fin-kpis' }, kpis.map(([k, v, tip]) => h('div', { key: k, className: 'fin-kpi', title: tip },
        h('div', { className: 'fin-kpi-label' }, k), h('div', { className: 'fin-kpi-value' }, v)))),
      h('div', { className: 'fin-tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', {
        key: id, type: 'button', role: 'tab', 'aria-selected': !detail && tab === id,
        className: 'fin-tab' + (!detail && tab === id ? ' on' : ''),
        onClick: () => { setDetail(null); setTab(id); }
      }, label, id === 'rates' && missing ? h('span', { className: 'fin-dot', 'aria-label': 'rates missing' }) : null))),
      body);
  }

  // ---- Overview ---------------------------------------------------------------

  function monthBuckets(keys, rows, ledger) {
    return keys.map((key) => {
      const fs = rows.filter((f) => monthKey(f.date) === key);
      const es = ledger.filter((e) => monthKey(e.date) === key);
      const revenue = sum(fs.filter(earns), (f) => f.billed) + sum(es.filter((e) => e.kind === 'income' && !isPrepay(e)), (e) => e.amount);
      const costs = sum(fs, (f) => f.tutorPay + f.extra) + sum(es.filter((e) => e.kind === 'expense'), (e) => e.amount);
      return { key, revenue, costs, net: revenue - costs, sessions: fs.length };
    });
  }
  function monthKeys(from, to) {
    const out = [];
    let [y, m] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) { out.push(y + '-' + pad2(m)); m++; if (m > 12) { m = 1; y++; } if (out.length > 240) break; }
    return out;
  }

  function Overview(c) {
    const dates = c.rows.map((f) => f.date).concat(c.ledger.map((e) => e.date)).filter(Boolean).sort();
    const from = c.range.from || dates[0], to = c.range.to || dates[dates.length - 1] || today();
    const chartMonths = from ? monthBuckets(monthKeys(from.slice(0, 7), (to < today() ? to : today()).slice(0, 7)), c.rows, c.ledger) : [];
    const n = new Date();
    const last12 = monthKeys(isoOf(new Date(n.getFullYear(), n.getMonth() - 11, 1)).slice(0, 7), today().slice(0, 7));
    const table = monthBuckets(last12, c.all, c.ledgerAll).reverse();
    const csv = () => saveCsv('finance-monthly-' + today() + '.csv', [['Month', 'Sessions', 'Revenue', 'Costs', 'Net', 'Margin']]
      .concat(table.map((m) => [m.key, m.sessions, dollars(m.revenue), dollars(m.costs), dollars(m.net), m.revenue ? pct(m.net, m.revenue) : ''])));
    return h('div', null,
      h('div', { className: 'card blueprint fin-card' },
        h('div', { className: 'fin-card-head' }, h('div', { className: 'card-title' }, 'Revenue vs costs by month'), h('span', { className: 'fin-muted' }, c.periodText)),
        h(MonthChart, { months: chartMonths })),
      h('div', { className: 'card blueprint fin-card' },
        h('div', { className: 'fin-card-head' }, h('div', { className: 'card-title' }, 'Last 12 months'), h(Btn, { onClick: csv }, 'Export CSV')),
        h(Table, { head: [{ label: 'Month' }, { label: 'Sessions', num: 1 }, { label: 'Revenue', num: 1 }, { label: 'Costs', num: 1 }, { label: 'Net', num: 1 }, { label: 'Margin', num: 1 }] },
          table.map((m) => h('tr', { key: m.key },
            h('td', null, monthLabel(m.key, true)), h('td', { className: 'num' }, m.sessions), h('td', { className: 'num' }, c.money(m.revenue)),
            h('td', { className: 'num' }, c.money(m.costs)), h('td', { className: 'num' + (m.net < 0 ? ' neg' : '') }, c.money(m.net)),
            h('td', { className: 'num' }, pct(m.net, m.revenue)))))));
  }

  // ---- Sessions ---------------------------------------------------------------

  function sessionCsv(list, nameOf) {
    return [['Date', 'Tutee', 'Tutor', 'Minutes', 'Billed', 'Paid to tutor', 'Extra cost', 'Extra cost note', 'Margin', 'Payment', 'Paid on', 'Payout', 'Payout on', 'Notes', 'Rate missing', 'Session id']]
      .concat(list.slice().sort((a, b) => a.date.localeCompare(b.date)).map((f) => [f.date, nameOf(f.tuteeId), nameOf(f.tutorId), f.minutes,
        dollars(f.billed), dollars(f.tutorPay), dollars(f.extra), f.extraNote, dollars(f.billed - f.tutorPay - f.extra),
        f.payment, f.paidOn, f.payout, f.payoutOn, f.notes, f.rateMissing ? 'yes' : '', f.sessionId]));
  }

  function SessionsTab(c) {
    const F = c.F;
    const [sel, setSel] = useState(() => new Set());
    const [pay, setPay] = useState('');
    const [payout, setPayout] = useState('');
    const [who, setWho] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [manual, setManual] = useState(null);
    const overdue = new Set(F.overdue().map((f) => f.id));

    const list = c.rows
      .filter((f) => (!pay || f.payment === pay) && (!payout || f.payout === payout) && (!who || f.tuteeId === who || f.tutorId === who))
      .sort((a, b) => b.date.localeCompare(a.date) || c.nameOf(a.tuteeId).localeCompare(c.nameOf(b.tuteeId)));
    const ids = list.map((f) => f.id);
    const picked = ids.filter((id) => sel.has(id));
    const run = (work) => { setBusy(true); setErr(''); return work().then(() => setBusy(false), (e) => { setBusy(false); setErr((e && e.message) || 'That did not save.'); }); };
    const edit = (id, patch) => run(() => F.updateRows([id], patch));
    const toggle = (id) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
    const allOn = picked.length > 0 && picked.length === ids.length;
    const people = c.users.filter((u) => u.role === 'student' || u.role === 'tutor').sort((a, b) => a.name.localeCompare(b.name));

    const head = [
      { label: h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: allOn, onChange: () => setSel(allOn ? new Set() : new Set(ids)) }) },
      { label: 'Date' }, { label: 'Tutee' }, { label: 'Tutor' }, { label: 'Min', num: 1 }, { label: 'Billed', num: 1 }, { label: 'To tutor', num: 1 },
      { label: 'Extra cost', num: 1 }, { label: 'Margin', num: 1 }, { label: 'Payment' }, { label: 'Payout' }, { label: '' }
    ];
    const s = (k) => sum(list, (f) => f[k]);
    return h('div', { className: 'card blueprint fin-card' },
      h('div', { className: 'fin-toolbar' },
        h(Select, { label: 'Payment status', value: pay, onChange: setPay, options: [['', 'Any payment']].concat(F.paymentStatuses.map((x) => [x, LABEL[x]])) }),
        h(Select, { label: 'Payout status', value: payout, onChange: setPayout, options: [['', 'Any payout'], ['owed', 'Owed'], ['paid', 'Paid']] }),
        h(Select, { label: 'Person', value: who, onChange: setWho, options: [['', 'Everyone']].concat(people.map((u) => [u.id, u.name + (u.role === 'tutor' ? ' (tutor)' : '')])) }),
        h('span', { style: { flex: 1 } }),
        h(Btn, { disabled: busy || !picked.length, onClick: () => run(() => F.updateRows(picked, { payment: 'paid' })).then(() => setSel(new Set())) }, 'Mark selected paid'),
        h(Btn, { disabled: busy || !picked.length, onClick: () => run(() => F.updateRows(picked, { payout: 'paid' })).then(() => setSel(new Set())) }, 'Mark payouts paid'),
        h(Btn, { onClick: () => saveCsv('finance-sessions-' + today() + '.csv', sessionCsv(list, c.nameOf)) }, 'Export CSV'),
        h(Btn, { kind: 'btn-primary', onClick: () => setManual(blankManual()) }, 'Log a session manually')),
      err ? h('p', { className: 'fin-err' }, err) : null,
      manual ? h(ManualForm, { c, value: manual, set: setManual, done: () => setManual(null) }) : null,
      picked.length ? h('p', { className: 'fin-muted' }, picked.length + ' selected · billed ' + c.money(sum(list.filter((f) => sel.has(f.id)), (f) => f.billed))) : null,
      list.length ? h(Table, {
        head: head,
        foot: h('tr', null, h('td', { colSpan: 5 }, list.length + ' sessions · ' + hours(s('minutes')) + ' h'),
          h('td', { className: 'num' }, c.money(s('billed'))), h('td', { className: 'num' }, c.money(s('tutorPay'))), h('td', { className: 'num' }, c.money(s('extra'))),
          h('td', { className: 'num' }, c.money(s('billed') - s('tutorPay') - s('extra'))), h('td', { colSpan: 3 }))
      }, list.map((f) => h('tr', { key: f.id, className: sel.has(f.id) ? 'sel' : undefined },
        h('td', null, h('input', { type: 'checkbox', 'aria-label': 'Select', checked: sel.has(f.id), onChange: () => toggle(f.id) })),
        h('td', { className: 'nowrap' }, fmtDate(f.date),
          overdue.has(f.id) ? h(Tag, { tone: 'bad', title: 'Unpaid for more than ' + F.overdueDays + ' days' }, 'Overdue') : null,
          f.rateMissing ? h(Tag, { tone: 'warn', title: 'Priced without a rate. Set one in Rates, then recalculate.' }, 'No rate') : null),
        h('td', null, h('a', { href: '#', onClick: (e) => { e.preventDefault(); c.setDetail({ kind: 'student', id: f.tuteeId }); } }, c.nameOf(f.tuteeId))),
        h('td', null, h('a', { href: '#', onClick: (e) => { e.preventDefault(); c.setDetail({ kind: 'tutor', id: f.tutorId }); } }, c.nameOf(f.tutorId))),
        h('td', { className: 'num' }, f.minutes),
        h('td', { className: 'num' }, h(MoneyInput, { label: 'Billed', cents: f.billed, onCommit: (v) => edit(f.id, { billed: v }) })),
        h('td', { className: 'num' }, h(MoneyInput, { label: 'Paid to tutor', cents: f.tutorPay, onCommit: (v) => edit(f.id, { tutorPay: v }) })),
        h('td', { className: 'num' }, h(MoneyInput, { label: 'Extra cost', cents: f.extra, onCommit: (v) => edit(f.id, { extra: v }) })),
        h('td', { className: 'num' + (f.billed - f.tutorPay - f.extra < 0 ? ' neg' : '') }, c.money(f.billed - f.tutorPay - f.extra)),
        h('td', null, h(Select, { label: 'Payment status', value: f.payment, onChange: (v) => edit(f.id, { payment: v }), options: F.paymentStatuses.map((x) => [x, LABEL[x]]) }),
          f.payment === 'paid' && f.paidOn ? h('div', { className: 'fin-sub' }, fmtDate(f.paidOn)) : null),
        h('td', null, h(Select, { label: 'Payout status', value: f.payout, onChange: (v) => edit(f.id, { payout: v }), options: [['owed', 'Owed'], ['paid', 'Paid']] }),
          f.payout === 'paid' && f.payoutOn ? h('div', { className: 'fin-sub' }, fmtDate(f.payoutOn)) : null),
        h('td', null, h('button', {
          type: 'button', className: 'btn btn-ghost fin-btn', 'aria-label': 'Delete finance row', title: 'Delete this finance row',
          onClick: () => { if (window.confirm('Delete the finance record for ' + c.nameOf(f.tuteeId) + ' on ' + fmtDate(f.date) + '? The calendar session is not touched.')) run(() => F.deleteRow(f.id)); }
        }, '×'))))) : h('p', { className: 'fin-muted' }, 'No completed sessions in this range. They appear here when a session is marked completed.'));
  }

  const blankManual = () => ({ tuteeId: '', tutorId: '', date: today(), time: '16:00', minutes: '60', notes: '', busy: false, err: '' });
  function ManualForm(props) {
    const { c, value: M, set } = props;
    const db = c.db;
    const tutees = c.users.filter((u) => u.role === 'student' && u.active).sort((a, b) => a.name.localeCompare(b.name));
    const tutors = c.users.filter((u) => u.role === 'tutor' && u.active).sort((a, b) => a.name.localeCompare(b.name));
    const up = (patch) => set(Object.assign({}, M, patch, { err: '' }));
    const pickTutee = (id) => { const t = db.tutorOf(id); up({ tuteeId: id, tutorId: M.tutorId || (t ? t.id : '') }); };
    const rate = M.tuteeId ? c.F.rateOn('tutee', M.tuteeId, M.date) : null;
    const preview = rate != null && Number(M.minutes) > 0 ? c.money(Math.round(rate * Number(M.minutes) / 60)) : null;
    const save = () => {
      set(Object.assign({}, M, { busy: true, err: '' }));
      c.F.logManualSession({ tuteeId: M.tuteeId, tutorId: M.tutorId, date: M.date, time: M.time, minutes: M.minutes, notes: M.notes })
        .then(props.done, (e) => set(Object.assign({}, M, { busy: false, err: (e && e.message) || 'That did not save.' })));
    };
    return h('div', { className: 'fin-form' },
      h('div', { className: 'card-kicker' }, 'Log a session manually'),
      h('p', { className: 'fin-muted', style: { margin: 0 } }, 'For a session that was never on the calendar. It is added to the calendar as completed and priced from the rates.'),
      h('div', { className: 'fin-grid' },
        field('Tutee', h(Select, { label: 'Tutee', value: M.tuteeId, onChange: pickTutee, options: [['', 'Choose…']].concat(tutees.map((u) => [u.id, u.name])) })),
        field('Tutor', h(Select, { label: 'Tutor', value: M.tutorId, onChange: (v) => up({ tutorId: v }), options: [['', 'Choose…']].concat(tutors.map((u) => [u.id, u.name])) })),
        field('Date', h('input', { className: 'input', type: 'date', value: M.date, onChange: (e) => up({ date: e.target.value }) })),
        field('Start', h('input', { className: 'input', type: 'time', value: M.time, onChange: (e) => up({ time: e.target.value }) })),
        field('Minutes', h('input', { className: 'input', type: 'number', min: 5, max: 720, step: 5, value: M.minutes, onChange: (e) => up({ minutes: e.target.value }) })),
        field('Notes', h('input', { className: 'input', value: M.notes, onChange: (e) => up({ notes: e.target.value }) }))),
      M.tuteeId ? h('p', { className: 'fin-muted', style: { margin: 0 } }, preview ? 'Bills ' + preview + ' at the tutee’s rate.' : 'This tutee has no rate on that date, so it will be priced at $0.') : null,
      M.err ? h('p', { className: 'fin-err' }, M.err) : null,
      h('div', { className: 'fin-actions' },
        h(Btn, { kind: 'btn-ghost', onClick: props.done }, 'Cancel'),
        h(Btn, { kind: 'btn-primary', disabled: M.busy || !M.tuteeId || !M.tutorId, onClick: save }, 'Log session')));
  }
  const field = (label, control) => h('label', { className: 'field fin-field' }, h('span', { className: 'fin-label' }, label), control);

  // ---- Ledger -----------------------------------------------------------------

  function ledgerCsv(list, nameOf) {
    return [['Date', 'Kind', 'Category', 'Amount', 'Counterparty', 'Tutee', 'Tutor', 'Note', 'Receipt']]
      .concat(list.slice().sort((a, b) => a.date.localeCompare(b.date)).map((e) => [e.date, e.kind, e.category, dollars(e.amount), e.counterparty,
        e.tuteeId ? nameOf(e.tuteeId) : '', e.tutorId ? nameOf(e.tutorId) : '', e.note, e.receiptUrl]));
  }
  const INCOME_DEFAULTS = ['package prepayment'];

  function LedgerTab(c) {
    const F = c.F;
    const settings = F.settings();
    const blank = (keep) => Object.assign({ id: '', kind: 'expense', category: '', amount: '', date: today(), tuteeId: '', tutorId: '', counterparty: '', note: '', receiptUrl: '' }, keep || {});
    const [form, setForm] = useState(() => blank());
    const [kind, setKind] = useState('');
    const [cat, setCat] = useState('');
    const [err, setErr] = useState('');
    const [saved, setSaved] = useState('');
    const [editQuick, setEditQuick] = useState(null);
    const amountRef = useRef(null);

    const categories = Array.from(new Set(c.ledgerAll.map((e) => e.category).concat(settings.quickCategories))).sort((a, b) => a.localeCompare(b));
    const list = c.ledger.filter((e) => (!kind || e.kind === kind) && (!cat || e.category === cat)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const up = (patch) => { setForm(Object.assign({}, form, patch)); setErr(''); setSaved(''); };
    const quick = (name) => {
      up({ category: name, kind: INCOME_DEFAULTS.indexOf(name.toLowerCase()) >= 0 ? 'income' : 'expense' });
      setTimeout(() => amountRef.current && amountRef.current.focus(), 0);
    };
    // Enter (the form's submit) saves and leaves the form open, keeping the
    // kind, category and date so a run of receipts goes in one after another.
    const submit = (e) => {
      if (e) e.preventDefault();
      const cents = F.parseMoney(form.amount);
      if (isNaN(cents) || cents <= 0) { setErr('Enter an amount like 45 or 45.00.'); return; }
      const entry = { kind: form.kind, category: form.category, amount: cents, date: form.date, tuteeId: form.tuteeId, tutorId: form.tutorId, counterparty: form.counterparty, note: form.note, receiptUrl: form.receiptUrl };
      const work = form.id ? F.updateLedger(form.id, entry) : F.addLedger(entry);
      work.then(() => {
        setSaved((form.id ? 'Updated ' : 'Added ') + (form.kind === 'income' ? 'income' : 'expense') + ' of ' + c.money(cents) + '.');
        setForm(blank({ kind: form.kind, category: form.category, date: form.date }));
        setTimeout(() => amountRef.current && amountRef.current.focus(), 0);
      }, (x) => setErr((x && x.message) || 'That did not save.'));
    };
    const students = c.users.filter((u) => u.role === 'student').sort((a, b) => a.name.localeCompare(b.name));
    const tutors = c.users.filter((u) => u.role === 'tutor').sort((a, b) => a.name.localeCompare(b.name));
    const inc = sum(list.filter((e) => e.kind === 'income'), (e) => e.amount), exp = sum(list.filter((e) => e.kind === 'expense'), (e) => e.amount);

    return h('div', null,
      h('form', { className: 'card blueprint fin-card fin-form', onSubmit: submit },
        h('div', { className: 'fin-card-head' },
          h('div', { className: 'card-title' }, form.id ? 'Edit entry' : 'Add entry'),
          h('span', { className: 'fin-muted' }, 'Enter saves and keeps the form open for the next one.')),
        h('div', { className: 'fin-quick' },
          settings.quickCategories.map((q) => h(Btn, { key: q, kind: 'btn-ghost', onClick: () => quick(q) }, '+ ' + q)),
          h('button', { type: 'button', className: 'btn btn-ghost fin-btn fin-muted', onClick: () => setEditQuick(settings.quickCategories.join(', ')) }, 'Edit buttons')),
        editQuick != null ? h('div', { className: 'fin-toolbar' },
          h('input', { className: 'input', 'aria-label': 'Quick-add categories, comma separated', value: editQuick, onChange: (e) => setEditQuick(e.target.value), style: { flex: 1 } }),
          h(Btn, {
            kind: 'btn-primary', onClick: () => {
              const next = Array.from(new Set(editQuick.split(',').map((x) => x.trim()).filter(Boolean))).slice(0, 12);
              F.saveSetting('quick_categories', next).then(() => setEditQuick(null), (x) => setErr((x && x.message) || 'That did not save.'));
            }
          }, 'Save buttons'),
          h(Btn, { kind: 'btn-ghost', onClick: () => setEditQuick(null) }, 'Cancel')) : null,
        h('div', { className: 'fin-grid' },
          field('Kind', h('div', { className: 'fin-toggle', role: 'group', 'aria-label': 'Kind' },
            ['expense', 'income'].map((k) => h('button', { key: k, type: 'button', 'aria-pressed': form.kind === k, className: 'btn fin-seg' + (form.kind === k ? ' on' : ''), onClick: () => up({ kind: k }) }, k === 'income' ? 'Income' : 'Expense')))),
          field('Amount', h('input', { ref: amountRef, className: 'input', inputMode: 'decimal', placeholder: '$0.00', value: form.amount, onChange: (e) => up({ amount: e.target.value }) })),
          field('Category', h('input', { className: 'input', list: 'fin-cats', maxLength: 60, value: form.category, onChange: (e) => up({ category: e.target.value }) })),
          field('Date', h('input', { className: 'input', type: 'date', value: form.date, onChange: (e) => up({ date: e.target.value }) })),
          field('Student', h(Select, { label: 'Student', value: form.tuteeId, onChange: (v) => up({ tuteeId: v }), options: [['', 'None']].concat(students.map((u) => [u.id, u.name])) })),
          field('Tutor', h(Select, { label: 'Tutor', value: form.tutorId, onChange: (v) => up({ tutorId: v }), options: [['', 'None']].concat(tutors.map((u) => [u.id, u.name])) })),
          field('Paid to / from', h('input', { className: 'input', value: form.counterparty, onChange: (e) => up({ counterparty: e.target.value }) })),
          field('Note', h('input', { className: 'input', value: form.note, onChange: (e) => up({ note: e.target.value }) })),
          field('Receipt link', h('input', { className: 'input', type: 'url', placeholder: 'https://', value: form.receiptUrl, onChange: (e) => up({ receiptUrl: e.target.value }) }))),
        h('datalist', { id: 'fin-cats' }, categories.map((x) => h('option', { key: x, value: x }))),
        err ? h('p', { className: 'fin-err' }, err) : null,
        saved ? h('p', { className: 'fin-ok' }, saved) : null,
        h('div', { className: 'fin-actions' },
          form.id ? h(Btn, { kind: 'btn-ghost', onClick: () => setForm(blank()) }, 'Cancel edit') : null,
          h('button', { type: 'submit', className: 'btn btn-primary fin-btn' }, form.id ? 'Save changes' : 'Add entry'))),
      h('div', { className: 'card blueprint fin-card' },
        h('div', { className: 'fin-toolbar' },
          h(Select, { label: 'Kind', value: kind, onChange: setKind, options: [['', 'Income and expenses'], ['income', 'Income'], ['expense', 'Expenses']] }),
          h(Select, { label: 'Category', value: cat, onChange: setCat, options: [['', 'Every category']].concat(categories.map((x) => [x, x])) }),
          h('span', { className: 'fin-muted', style: { flex: 1 } }, 'Income ' + c.money(inc) + ' · expenses ' + c.money(exp)),
          h(Btn, { onClick: () => saveCsv('finance-ledger-' + today() + '.csv', ledgerCsv(list, c.nameOf)) }, 'Export CSV')),
        list.length ? h(Table, { head: [{ label: 'Date' }, { label: 'Category' }, { label: 'Linked to' }, { label: 'Note' }, { label: 'Amount', num: 1 }, { label: '' }] },
          list.map((e) => h('tr', { key: e.id },
            h('td', { className: 'nowrap' }, fmtDate(e.date)),
            h('td', null, h(Tag, { tone: e.kind === 'income' ? 'good' : 'muted' }, e.kind === 'income' ? 'Income' : 'Expense'), ' ', e.category),
            h('td', null, [e.tuteeId ? c.nameOf(e.tuteeId) : '', e.tutorId ? c.nameOf(e.tutorId) : '', e.counterparty].filter(Boolean).join(' · ') || '—'),
            h('td', null, e.note || '', e.receiptUrl ? h('a', { href: e.receiptUrl, target: '_blank', rel: 'noopener noreferrer', style: { marginLeft: e.note ? '6px' : 0 } }, 'Receipt') : null),
            h('td', { className: 'num' + (e.kind === 'expense' ? ' neg' : '') }, (e.kind === 'expense' ? '−' : '') + c.money(e.amount)),
            h('td', { className: 'nowrap' },
              h('button', { type: 'button', className: 'btn btn-ghost fin-btn', onClick: () => { setForm({ id: e.id, kind: e.kind, category: e.category, amount: (e.amount / 100).toFixed(2), date: e.date, tuteeId: e.tuteeId, tutorId: e.tutorId, counterparty: e.counterparty, note: e.note, receiptUrl: e.receiptUrl }); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, 'Edit'),
              h('button', { type: 'button', className: 'btn btn-ghost fin-btn', 'aria-label': 'Delete entry', onClick: () => { if (window.confirm('Delete this ' + e.kind + ' of ' + c.money(e.amount) + '?')) F.deleteLedger(e.id).catch(() => {}); } }, '×'))))) : h('p', { className: 'fin-muted' }, 'No ledger entries in this range.')));
  }

  // ---- By Student -------------------------------------------------------------

  function byStudent(users, rows, ledger, allRows, allLedger) {
    const ids = new Set(users.filter((u) => u.role === 'student').map((u) => u.id));
    rows.forEach((f) => f.tuteeId && ids.add(f.tuteeId));
    ledger.forEach((e) => e.tuteeId && ids.add(e.tuteeId));
    return Array.from(ids).map((id) => {
      const fs = rows.filter((f) => f.tuteeId === id), es = ledger.filter((e) => e.tuteeId === id);
      const lfs = allRows.filter((f) => f.tuteeId === id), les = allLedger.filter((e) => e.tuteeId === id);
      const u = window.db.getUser(id);
      return {
        id, name: u ? u.name : 'Deleted user', active: !!(u && u.active),
        sessions: fs.length, minutes: sum(fs, (f) => f.minutes),
        billed: sum(fs.filter(earns), (f) => f.billed),
        paid: sum(fs.filter((f) => f.payment === 'paid'), (f) => f.billed),
        outstanding: sum(fs.filter((f) => f.payment === 'unpaid'), (f) => f.billed),
        prepaid: sum(es.filter(isPrepay), (e) => e.amount),
        refunds: sum(es.filter(isRefund), (e) => e.amount),
        otherIn: sum(es.filter((e) => e.kind === 'income' && !isPrepay(e)), (e) => e.amount),
        // Everything they have been charged, ever, less what was handed back.
        ltv: sum(lfs.filter(earns), (f) => f.billed) + sum(les.filter((e) => e.kind === 'income' && !isPrepay(e)), (e) => e.amount) - sum(les.filter(isRefund), (e) => e.amount)
      };
    }).filter((r) => r.active || r.sessions || r.ltv || r.prepaid || r.refunds).sort((a, b) => a.name.localeCompare(b.name));
  }
  const byStudentCsv = (list) => [['Tutee', 'Sessions', 'Hours', 'Billed', 'Paid', 'Outstanding', 'Prepayments', 'Refunds', 'Lifetime value']]
    .concat(list.map((r) => [r.name, r.sessions, hours(r.minutes), dollars(r.billed), dollars(r.paid), dollars(r.outstanding), dollars(r.prepaid), dollars(r.refunds), dollars(r.ltv)]));

  function StudentsTab(c) {
    const list = byStudent(c.users, c.rows, c.ledger, c.all, c.ledgerAll);
    const t = (k) => sum(list, (r) => r[k]);
    return h('div', { className: 'card blueprint fin-card' },
      h('div', { className: 'fin-toolbar' },
        h('span', { className: 'fin-muted', style: { flex: 1 } }, 'Click a tutee for their statement. Lifetime value is all-time; the rest follow the date range.'),
        h(Btn, { onClick: () => saveCsv('finance-by-student-' + today() + '.csv', byStudentCsv(list)) }, 'Export CSV')),
      h(Table, {
        head: [{ label: 'Tutee' }, { label: 'Sessions', num: 1 }, { label: 'Hours', num: 1 }, { label: 'Billed', num: 1 }, { label: 'Paid', num: 1 }, { label: 'Outstanding', num: 1 }, { label: 'Prepaid', num: 1 }, { label: 'Refunds', num: 1 }, { label: 'Lifetime', num: 1 }],
        foot: h('tr', null, h('td', null, 'Total'), h('td', { className: 'num' }, t('sessions')), h('td', { className: 'num' }, hours(t('minutes'))), h('td', { className: 'num' }, c.money(t('billed'))),
          h('td', { className: 'num' }, c.money(t('paid'))), h('td', { className: 'num' }, c.money(t('outstanding'))), h('td', { className: 'num' }, c.money(t('prepaid'))),
          h('td', { className: 'num' }, c.money(t('refunds'))), h('td', { className: 'num' }, c.money(t('ltv'))))
      }, list.map((r) => h('tr', { key: r.id, className: 'click', onClick: () => c.setDetail({ kind: 'student', id: r.id }) },
        h('td', null, h('a', { href: '#', onClick: (e) => e.preventDefault() }, r.name), r.active ? null : h(Tag, { tone: 'muted' }, 'Inactive')),
        h('td', { className: 'num' }, r.sessions), h('td', { className: 'num' }, hours(r.minutes)), h('td', { className: 'num' }, c.money(r.billed)),
        h('td', { className: 'num' }, c.money(r.paid)), h('td', { className: 'num' + (r.outstanding ? ' warn' : '') }, c.money(r.outstanding)),
        h('td', { className: 'num' }, c.money(r.prepaid)), h('td', { className: 'num' }, c.money(r.refunds)), h('td', { className: 'num' }, c.money(r.ltv))))));
  }

  function Statement(c) {
    const id = c.tuteeId, name = c.nameOf(id);
    const fs = c.rows.filter((f) => f.tuteeId === id).sort((a, b) => a.date.localeCompare(b.date));
    const es = c.ledger.filter((e) => e.tuteeId === id).sort((a, b) => a.date.localeCompare(b.date));
    const lines = fs.map((f) => ({ date: f.date, what: 'Tutoring, ' + f.minutes + ' min with ' + c.nameOf(f.tutorId), status: LABEL[f.payment], amount: f.payment === 'waived' || f.payment === 'comped' ? 0 : f.billed }))
      .concat(es.map((e) => ({ date: e.date, what: e.category + (e.note ? ' — ' + e.note : ''), status: e.kind === 'income' ? 'Received' : 'Credited', amount: e.kind === 'income' ? e.amount : -e.amount })))
      .sort((a, b) => a.date.localeCompare(b.date));
    const billed = sum(fs.filter(earns), (f) => f.billed);
    const paid = sum(fs.filter((f) => f.payment === 'paid'), (f) => f.billed);
    const outstanding = sum(fs.filter((f) => f.payment === 'unpaid'), (f) => f.billed);
    const totals = [['Billed', billed], ['Paid', paid]]
      .concat(es.some(isPrepay) ? [['Prepaid', sum(es.filter(isPrepay), (e) => e.amount)]] : [])
      .concat(es.some(isRefund) ? [['Refunded', sum(es.filter(isRefund), (e) => e.amount)]] : [])
      .concat([['Balance due', outstanding]]);
    const csv = () => saveCsv('statement-' + name.replace(/[^\w-]+/g, '-').toLowerCase() + '-' + today() + '.csv',
      [['Statement', name, c.periodText], [], ['Date', 'Item', 'Status', 'Amount']]
        .concat(lines.map((l) => [l.date, l.what, l.status, dollars(l.amount)]), [[]], totals.map(([k, v]) => [k, '', '', dollars(v)])));
    return h('div', { className: 'card blueprint fin-card' },
      h('div', { className: 'fin-card-head' },
        h('div', null, h('a', { href: '#', onClick: (e) => { e.preventDefault(); c.setDetail(null); c.setTab('students'); } }, '← By Student'),
          h('div', { className: 'card-title' }, 'Statement · ' + name), h('div', { className: 'fin-muted' }, c.periodText)),
        h('div', { className: 'fin-actions' },
          h(Btn, { onClick: csv }, 'Export CSV'),
          h(Btn, { kind: 'btn-primary', onClick: () => printStatement({ name, period: c.periodText, lines, totals }) }, 'Export PDF'))),
      lines.length ? h(Table, { head: [{ label: 'Date' }, { label: 'Item' }, { label: 'Status' }, { label: 'Amount', num: 1 }] },
        lines.map((l, i) => h('tr', { key: i }, h('td', { className: 'nowrap' }, fmtDate(l.date)), h('td', null, l.what), h('td', null, l.status), h('td', { className: 'num' }, c.money(l.amount)))))
        : h('p', { className: 'fin-muted' }, 'Nothing for ' + name + ' in this range.'),
      h('div', { className: 'fin-totals' }, totals.map(([k, v]) => h('div', { key: k }, h('span', null, k), h('b', null, c.money(v))))),
      h('p', { className: 'fin-muted' }, 'Export PDF opens a print view; choose “Save as PDF” as the printer.'));
  }

  // ---- By Tutor ---------------------------------------------------------------

  function byTutor(users, rows) {
    const ids = new Set(users.filter((u) => u.role === 'tutor').map((u) => u.id));
    rows.forEach((f) => f.tutorId && ids.add(f.tutorId));
    return Array.from(ids).map((id) => {
      const fs = rows.filter((f) => f.tutorId === id);
      const u = window.db.getUser(id);
      const minutes = sum(fs, (f) => f.minutes), pay = sum(fs, (f) => f.tutorPay);
      const revenue = sum(fs.filter(earns), (f) => f.billed);
      return {
        id, name: u ? u.name : 'Deleted user', active: !!(u && u.active),
        sessions: fs.length, minutes,
        owed: sum(fs.filter((f) => f.payout === 'owed'), (f) => f.tutorPay),
        paid: sum(fs.filter((f) => f.payout === 'paid'), (f) => f.tutorPay),
        hourly: minutes ? Math.round(pay / (minutes / 60)) : null,
        revenue, margin: revenue - pay - sum(fs, (f) => f.extra)
      };
    }).filter((r) => r.active || r.sessions).sort((a, b) => a.name.localeCompare(b.name));
  }
  const byTutorCsv = (list) => [['Tutor', 'Sessions', 'Hours', 'Owed', 'Paid', 'Effective hourly', 'Revenue generated', 'Margin', 'Margin %']]
    .concat(list.map((r) => [r.name, r.sessions, hours(r.minutes), dollars(r.owed), dollars(r.paid), r.hourly == null ? '' : dollars(r.hourly), dollars(r.revenue), dollars(r.margin), r.revenue ? pct(r.margin, r.revenue) : '']));

  function TutorsTab(c) {
    const list = byTutor(c.users, c.rows);
    return h('div', { className: 'card blueprint fin-card' },
      h('div', { className: 'fin-toolbar' },
        h('span', { className: 'fin-muted', style: { flex: 1 } }, 'Click a tutor for their payout. A group session pays the tutor once, split across the tutees who came.'),
        h(Btn, { onClick: () => saveCsv('finance-by-tutor-' + today() + '.csv', byTutorCsv(list)) }, 'Export CSV')),
      h(Table, { head: [{ label: 'Tutor' }, { label: 'Sessions', num: 1 }, { label: 'Hours', num: 1 }, { label: 'Owed', num: 1 }, { label: 'Paid', num: 1 }, { label: 'Per hour', num: 1 }, { label: 'Revenue', num: 1 }, { label: 'Margin', num: 1 }] },
        list.map((r) => h('tr', { key: r.id, className: 'click', onClick: () => c.setDetail({ kind: 'tutor', id: r.id }) },
          h('td', null, h('a', { href: '#', onClick: (e) => e.preventDefault() }, r.name), r.active ? null : h(Tag, { tone: 'muted' }, 'Inactive')),
          h('td', { className: 'num' }, r.sessions), h('td', { className: 'num' }, hours(r.minutes)),
          h('td', { className: 'num' + (r.owed ? ' warn' : '') }, c.money(r.owed)), h('td', { className: 'num' }, c.money(r.paid)),
          h('td', { className: 'num' }, r.hourly == null ? '—' : c.money(r.hourly)), h('td', { className: 'num' }, c.money(r.revenue)),
          h('td', { className: 'num' + (r.margin < 0 ? ' neg' : '') }, c.money(r.margin) + ' (' + pct(r.margin, r.revenue) + ')')))));
  }

  function Payout(c) {
    const F = c.F, id = c.tutorId, name = c.nameOf(id);
    const [on, setOn] = useState(today());
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const fs = c.rows.filter((f) => f.tutorId === id).sort((a, b) => a.date.localeCompare(b.date));
    const owedRows = fs.filter((f) => f.payout === 'owed');
    const owed = sum(owedRows, (f) => f.tutorPay);
    const markAll = () => {
      setBusy(true); setErr('');
      F.updateRows(owedRows.map((f) => f.id), { payout: 'paid', payoutOn: on })
        .then(() => setBusy(false), (e) => { setBusy(false); setErr((e && e.message) || 'That did not save.'); });
    };
    const csv = () => saveCsv('payout-' + name.replace(/[^\w-]+/g, '-').toLowerCase() + '-' + today() + '.csv',
      [['Date', 'Tutee', 'Minutes', 'Pay', 'Payout', 'Paid on']].concat(fs.map((f) => [f.date, c.nameOf(f.tuteeId), f.minutes, dollars(f.tutorPay), f.payout, f.payoutOn])));
    return h('div', { className: 'card blueprint fin-card' },
      h('div', { className: 'fin-card-head' },
        h('div', null, h('a', { href: '#', onClick: (e) => { e.preventDefault(); c.setDetail(null); c.setTab('tutors'); } }, '← By Tutor'),
          h('div', { className: 'card-title' }, 'Payout · ' + name), h('div', { className: 'fin-muted' }, c.periodText + ' · ' + c.money(owed) + ' owed on ' + owedRows.length + ' sessions')),
        h('div', { className: 'fin-actions' },
          h(Btn, { onClick: csv }, 'Export CSV'),
          h('input', { className: 'input', type: 'date', 'aria-label': 'Paid on', value: on, onChange: (e) => setOn(e.target.value), style: { width: 'auto' } }),
          h(Btn, { kind: 'btn-primary', disabled: busy || !owedRows.length || !on, onClick: markAll }, 'Mark all as paid on ' + fmtDate(on)))),
      err ? h('p', { className: 'fin-err' }, err) : null,
      fs.length ? h(Table, { head: [{ label: 'Date' }, { label: 'Tutee' }, { label: 'Min', num: 1 }, { label: 'Pay', num: 1 }, { label: 'Payout' }] },
        fs.map((f) => h('tr', { key: f.id },
          h('td', { className: 'nowrap' }, fmtDate(f.date)), h('td', null, c.nameOf(f.tuteeId)), h('td', { className: 'num' }, f.minutes),
          h('td', { className: 'num' }, h(MoneyInput, { label: 'Pay', cents: f.tutorPay, onCommit: (v) => F.updateRows([f.id], { tutorPay: v }).catch(() => {}) })),
          h('td', null, h(Tag, { tone: STATUS_TONE[f.payout] }, LABEL[f.payout]), f.payoutOn ? h('span', { className: 'fin-sub' }, ' ' + fmtDate(f.payoutOn)) : null))))
        : h('p', { className: 'fin-muted' }, 'No sessions for ' + name + ' in this range.'));
  }

  // ---- Rates ------------------------------------------------------------------

  function rateCsv(kind, people, F) {
    const out = [[kind === 'tutee' ? 'Tutee' : 'Tutor', 'Hourly rate', 'Effective from']];
    people.forEach((u) => F.rates(kind, u.id).slice().reverse().forEach((r) => out.push([u.name, dollars(r.cents), r.from])));
    return out;
  }

  function RateRow(props) {
    const { F, kind, u, money } = props;
    const hist = F.rates(kind, u.id);
    const cur = F.rateOn(kind, u.id, today());
    const next = hist.filter((r) => r.from > today()).pop();
    const [open, setOpen] = useState(false);
    const [amt, setAmt] = useState('');
    const [from, setFrom] = useState(today());
    const [err, setErr] = useState('');
    const add = (e) => {
      if (e) e.preventDefault();
      const cents = F.parseMoney(amt);
      if (isNaN(cents)) { setErr('Enter an hourly rate like 45 or 45.00.'); return; }
      F.setRate(kind, u.id, cents, from).then(() => { setAmt(''); setErr(''); }, (x) => setErr((x && x.message) || 'That did not save.'));
    };
    return h(R.Fragment, null,
      h('tr', { className: !hist.length && u.active ? 'missing' : undefined },
        h('td', null, u.name, u.active ? null : h(Tag, { tone: 'muted' }, 'Inactive'), !hist.length && u.active ? h(Tag, { tone: 'bad' }, 'No rate') : null),
        h('td', { className: 'num' }, cur == null ? '—' : money(cur) + '/h'),
        h('td', { className: 'fin-muted' }, next ? money(next.cents) + '/h from ' + fmtDate(next.from) : ''),
        h('td', null, h('form', { className: 'fin-inline', onSubmit: add },
          h('input', { className: 'input fin-money', inputMode: 'decimal', placeholder: '$/hour', 'aria-label': 'New hourly rate for ' + u.name, value: amt, onChange: (e) => setAmt(e.target.value) }),
          h('input', { className: 'input', type: 'date', 'aria-label': 'Effective from', value: from, onChange: (e) => setFrom(e.target.value) }),
          h('button', { type: 'submit', className: 'btn btn-secondary fin-btn' }, 'Set'),
          hist.length ? h('button', { type: 'button', className: 'btn btn-ghost fin-btn', onClick: () => setOpen(!open) }, open ? 'Hide history' : 'History (' + hist.length + ')') : null),
          err ? h('div', { className: 'fin-err' }, err) : null)),
      open ? hist.map((r) => h('tr', { key: r.id, className: 'hist' },
        h('td', null), h('td', { className: 'num' }, money(r.cents) + '/h'), h('td', { className: 'fin-muted' }, 'from ' + fmtDate(r.from)),
        h('td', null, h('button', { type: 'button', className: 'btn btn-ghost fin-btn', onClick: () => { if (window.confirm('Remove this rate? Sessions already priced keep their amounts.')) F.deleteRate(kind, r.id).catch(() => {}); } }, 'Remove')))) : null);
  }

  function RatesTab(c) {
    const F = c.F;
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');
    const [tz, setTz] = useState(F.settings().timezone);
    const needs = c.all.filter((f) => f.rateMissing);
    const list = (role) => c.users.filter((u) => u.role === role).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    const section = (kind, role, title, missingList) => h('div', { className: 'card blueprint fin-card' },
      h('div', { className: 'fin-card-head' },
        h('div', { className: 'card-title' }, title),
        h(Btn, { onClick: () => saveCsv(kind + '-rates-' + today() + '.csv', rateCsv(kind, list(role), F)) }, 'Export CSV')),
      missingList.length ? h('p', { className: 'fin-err' }, 'No rate yet: ' + missingList.map((u) => u.name).join(', ') + '.') : null,
      h(Table, { head: [{ label: role === 'student' ? 'Tutee' : 'Tutor' }, { label: 'Current', num: 1 }, { label: 'Scheduled' }, { label: 'New rate' }] },
        list(role).map((u) => h(RateRow, { key: u.id, F, kind, u, money: c.money }))));
    return h('div', null,
      h('div', { className: 'card blueprint fin-card' },
        h('p', { className: 'fin-muted', style: { margin: 0 } },
          'A session is priced at the rates in effect on its date when it is marked completed. Setting a new rate with a later start date leaves every session before it as it was. Tutee rate × hours is what they are billed; tutor rate × hours is the payout.'),
        needs.length ? h('div', { className: 'fin-toolbar' },
          h('span', { style: { flex: 1 } }, needs.length + (needs.length === 1 ? ' session was' : ' sessions were') + ' priced without a rate.'),
          h(Btn, {
            kind: 'btn-primary', disabled: busy, onClick: () => {
              setBusy(true); setMsg('');
              F.recalc(needs.map((f) => f.id)).then((n) => { setBusy(false); setMsg('Recalculated ' + n + (n === 1 ? ' session.' : ' sessions.')); }, (e) => { setBusy(false); setMsg((e && e.message) || 'Could not recalculate.'); });
            }
          }, 'Recalculate from rates')) : null,
        msg ? h('p', { className: 'fin-ok' }, msg) : null,
        h('div', { className: 'fin-toolbar' },
          h('label', { className: 'fin-muted', htmlFor: 'fin-tz' }, 'Business time zone (which day an evening session counts on)'),
          h('input', { id: 'fin-tz', className: 'input', style: { width: '220px' }, value: tz, onChange: (e) => setTz(e.target.value) }),
          h(Btn, { disabled: tz === F.settings().timezone, onClick: () => F.saveSetting('timezone', tz.trim()).catch(() => {}) }, 'Save'),
          h('button', { type: 'button', className: 'btn btn-ghost fin-btn', onClick: () => setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') }, 'Use this browser’s'))),
      section('tutee', 'student', 'Tutee billing rates', c.missingTutees || []),
      section('tutor', 'tutor', 'Tutor pay rates', c.missingTutors || []));
  }

  window.PpaFinance = PpaFinance;
})();
