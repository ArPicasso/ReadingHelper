// Column charts as plain SVG. One series per chart, so identity never depends on
// colour: the title names the series and the bars carry a single hue.
//
// Mark specs: bars capped at 24px with a 4px rounded top and a square foot on
// the baseline, a 2px surface gap between neighbours, hairline solid gridlines,
// axis text in muted ink, and a selective direct label on the tallest bar only.
// Every bar has a hover target wider than the bar itself, plus a table view
// underneath for anyone who cannot use either.

const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/** Rounded top, square foot — a bar that grows out of its baseline. */
function barPath(x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0) return '';
  return [
    `M${x},${y + h}`,
    `V${y + radius}`,
    `a${radius},${radius} 0 0 1 ${radius},${-radius}`,
    `h${w - 2 * radius}`,
    `a${radius},${radius} 0 0 1 ${radius},${radius}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

/** Clean axis steps: 1, 2, 5 × 10ⁿ. */
function niceStep(max, targetTicks = 3) {
  const raw = Math.max(1, max) / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/**
 * @param {HTMLElement} host           container; gets the svg plus a tooltip
 * @param {object}      spec
 * @param {Array}       spec.data      rows
 * @param {Function}    spec.value     row → number
 * @param {Function}    spec.label     row, index → short axis label ('' to skip)
 * @param {Function}    spec.tooltip   row → string (plain text)
 * @param {number}     [spec.reference] value for the target line
 * @param {string}     [spec.referenceLabel]
 */
export function columnChart(host, spec) {
  const { data, value, label, tooltip, reference, referenceLabel } = spec;
  host.replaceChildren();
  if (!data.length) return;

  const width = Math.max(240, Math.floor(host.clientWidth || 320));
  const height = Number(host.dataset.height || 148);
  const padding = { top: 16, right: 4, bottom: 18, left: 26 };

  const values = data.map(value);
  const peak = Math.max(...values, reference ?? 0, 1);
  const step = niceStep(peak);
  const top = Math.ceil(peak / step) * step;

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const slot = plotW / data.length;
  const barW = Math.max(2, Math.min(MAX_BAR, slot - GAP));
  const y = (v) => padding.top + plotH - (v / top) * plotH;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height,
    role: 'img',
    'aria-label': host.dataset.aria || 'Столбчатая диаграмма',
  });

  // Gridlines first, so data always sits on top of chrome.
  for (let v = 0; v <= top; v += step) {
    svg.append(svgEl('line', {
      x1: padding.left, x2: width - padding.right, y1: y(v), y2: y(v),
      class: v === 0 ? 'chart-baseline' : 'chart-grid',
    }));
    const tick = svgEl('text', { x: padding.left - 6, y: y(v) + 3, class: 'chart-tick' });
    tick.textContent = String(v);
    svg.append(tick);
  }

  if (reference != null && reference > 0 && reference <= top) {
    svg.append(svgEl('line', {
      x1: padding.left, x2: width - padding.right, y1: y(reference), y2: y(reference),
      class: 'chart-reference',
    }));
    if (referenceLabel) {
      const note = svgEl('text', {
        x: width - padding.right, y: y(reference) - 4, class: 'chart-reference-label',
        'text-anchor': 'end',
      });
      note.textContent = referenceLabel;
      svg.append(note);
    }
  }

  const peakIndex = values.indexOf(Math.max(...values));

  data.forEach((row, i) => {
    const v = value(row);
    const x = padding.left + i * slot + (slot - barW) / 2;
    const h = v > 0 ? Math.max(2, plotH - (y(v) - padding.top)) : 0;

    if (h > 0) {
      svg.append(svgEl('path', { d: barPath(x, y(v), barW, h, RADIUS), class: 'chart-bar' }));
    } else {
      // An explicit zero reads better than a gap the eye has to interpret.
      svg.append(svgEl('circle', { cx: x + barW / 2, cy: y(0) - 2, r: 1.5, class: 'chart-zero' }));
    }

    const text = label(row, i);
    if (text) {
      const tick = svgEl('text', {
        x: x + barW / 2, y: height - 6, class: 'chart-tick', 'text-anchor': 'middle',
      });
      tick.textContent = text;
      svg.append(tick);
    }

    // One direct label, on the peak — sparing enough to still mean something.
    if (i === peakIndex && v > 0) {
      const direct = svgEl('text', {
        x: x + barW / 2, y: y(v) - 5, class: 'chart-value', 'text-anchor': 'middle',
      });
      direct.textContent = String(v);
      svg.append(direct);
    }

    // Hit target: the whole slot, full height — much easier than a 5px bar.
    const hit = svgEl('rect', {
      x: padding.left + i * slot, y: padding.top, width: slot, height: plotH,
      class: 'chart-hit', tabindex: 0, role: 'button',
      'aria-label': tooltip(row),
    });
    const show = () => showTip(host, hit, tooltip(row));
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => hideTip(host));
    hit.addEventListener('blur', () => hideTip(host));
    svg.append(hit);
  });

  host.append(svg);
}

function tipFor(host) {
  let tip = host.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    host.append(tip);
  }
  return tip;
}

function showTip(host, target, text) {
  const tip = tipFor(host);
  tip.textContent = text;
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  const hostBox = host.getBoundingClientRect();
  const left = box.left - hostBox.left + box.width / 2;
  tip.style.left = `${Math.max(4, Math.min(hostBox.width - 4, left))}px`;
}

function hideTip(host) {
  const tip = host.querySelector('.chart-tip');
  if (tip) tip.hidden = true;
}

/** The table view every chart needs to have. */
export function chartTable(host, { data, columns }) {
  const table = document.createElement('table');
  table.className = 'data-table';
  const head = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c.title;
    head.append(th);
  }
  table.append(head);
  for (const row of data) {
    const tr = document.createElement('tr');
    for (const c of columns) {
      const td = document.createElement('td');
      td.textContent = c.value(row);
      tr.append(td);
    }
    table.append(tr);
  }
  host.replaceChildren(table);
}
