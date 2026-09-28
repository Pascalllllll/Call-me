// All user-provided text goes through textContent, never innerHTML.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3',
  micOff: 'M3 3l18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.8-1M5 12a7 7 0 0 0 11.6 5.3M19 12a7 7 0 0 1-.6 2.7M12 19v3',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v6H5a1 1 0 0 1-1-1v-5Zm16 0h-3v6h2a1 1 0 0 0 1-1v-5Z',
  headphonesOff: 'M3 3l18 18M4 15v-3a8 8 0 0 1 2.3-5.6M9 4.6A8 8 0 0 1 20 12v3M4 15h3v6H5a1 1 0 0 1-1-1v-5Zm16 0h-3v6h2a1 1 0 0 0 1-1v-5Z',
  camera: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  cameraOff: 'M3 3l18 18M15 11V7H8M3 7v10h12v-2M15 10l6-3v10l-5-2.5',
  screen: 'M3 4h18v12H3zM8 20h8M12 16v4',
  leave: 'M5 15c4-4 10-4 14 0l-2 3-3-1v-3a9 9 0 0 0-4 0v3l-3 1Z',
  plus: 'M12 5v14M5 12h14',
  hash: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
  speaker: 'M4 9v6h4l5 4V5L8 9H4Zm12 0a4 4 0 0 1 0 6',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8 3-2-.6a6 6 0 0 0-.6-1.5l1-1.9-1.4-1.4-1.9 1a6 6 0 0 0-1.5-.6L13 4h-2l-.6 2a6 6 0 0 0-1.5.6l-1.9-1-1.4 1.4 1 1.9a6 6 0 0 0-.6 1.5L4 11v2l2 .6a6 6 0 0 0 .6 1.5l-1 1.9 1.4 1.4 1.9-1a6 6 0 0 0 1.5.6l.6 2h2l.6-2a6 6 0 0 0 1.5-.6l1.9 1 1.4-1.4-1-1.9a6 6 0 0 0 .6-1.5l2-.6Z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  x: 'M6 6l12 12M18 6 6 18',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  auto: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18ZM12 3v18M12 8l4.5-3.5M12 13l7-5.5M12 18l6.5-5',
};

export function icon(name, label) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', label ? 'false' : 'true');
  if (label) svg.setAttribute('aria-label', label);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => [...p][0] || '').join('').toUpperCase() || '?';
}

export function formatTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}
