const PATHS: Record<string, string> = {
  database:
    "M8 1.5c-2.5 0-4.5.9-4.5 2S5.5 5.5 8 5.5s4.5-.9 4.5-2S10.5 1.5 8 1.5Zm4.5 2v2c0 1.1-2 2-4.5 2s-4.5-.9-4.5-2v-2m9 3.5v2c0 1.1-2 2-4.5 2s-4.5-.9-4.5-2v-2m9 3.5v1.75c0 1.1-2 2-4.5 2s-4.5-.9-4.5-2V11.5",
  server:
    "M2 2.5h12v4H2v-4Zm0 7h12v4H2v-4ZM4 4.5h.01M4 9.5h.01M6 4.5h4M6 9.5h4",
  table:
    "M2 3h12v10H2V3Zm0 3h12M6 6v7M2 6v7M10 6v7",
  schema:
    "M8 1.5 14 4.5 8 7.5 2 4.5 8 1.5ZM2 8l6 3 6-3M2 11.5l6 3 6-3",
  plug:
    "M5 2v3m6-3v3M3.5 5h9v2a4.5 4.5 0 0 1-4.5 4.5A4.5 4.5 0 0 1 3.5 7V5ZM8 11.5V14",
  play: "M4 2.6v10.8L13 8 4 2.6Z",
  stop: "M3.5 3.5h9v9h-9z",
  plus: "M8 2.5v11M2.5 8h11",
  close: "m3 3 10 10M13 3 3 13",
  more: "M3 8h.01M8 8h.01M13 8h.01",
  key: "M10.5 2.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8.4 8.6 2.5 14.5M5.5 11.5l1.5 1.5M7.5 9.5l1.5 1.5",
  refresh:
    "M13.3 6A5.5 5.5 0 1 0 13 10M13 2.7V6H9.7",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM10.4 10.4 14 14",
  download:
    "M8 2v7.5m0 0L4.8 6.3M8 9.5l3.2-3.2M2.5 11.5v1.2c0 .4.3.8.8.8h9.4c.5 0 .8-.4.8-.8v-1.2",
  history:
    "M2.5 8a5.5 5.5 0 1 0 1.7-4M2.5 2.5V6H6M8 4.5V8l2.5 1.5",
  settings:
    "M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5ZM8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9",
  edit: "M2.5 11.2 3 9l7.6-7.6 2.9 2.9L5.9 12l-3.4 1.2v-2ZM9.5 2.5l3 3",
  trash:
    "M2.5 4h11M6 1.8h4M4 4l.7 10h6.6L12 4M6.2 6.5v4.7M9.8 6.5v4.7",
  copy:
    "M5.5 5.5h8v9h-8v-9ZM2.5 10.5v-8h8",
  save:
    "M2.5 2.5h9L14 5v8.5h-11v-11Zm2.5 0v4h5v-4M5 13.5v-4h6v4",
  "folder-open":
    "M1.7 12.8 3.5 6h11l-1.8 6.8H1.7ZM1.7 12.8V3.2h4l1.5 1.8h6.3v1",
  check: "m2.5 8.2 3.4 3.4 7.6-7.6",
  alert:
    "M8 1.7 14.5 13h-13L8 1.7ZM8 6v3.4M8 11.4h.01",
  info: "M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 7v4M8 4.8h.01",
  x: "m4 4 8 8M12 4l-8 8",
  "chevron-right": "m6 3.5 5 4.5-5 4.5",
  "chevron-down": "m3.5 6 4.5 5 4.5-5",
  "panel-left":
    "M2 2.5h12v11H2v-11Zm4 0v11M9 5h3M9 8h3",
  "file-plus":
    "M3 1.5h6l4 4v9H3v-13Zm6 0v4h4M5.5 9h5M8 6.5v5",
  code: "m5.5 4.5-4 3.5 4 3.5m5-7 4 3.5-4 3.5",
  terminal:
    "M2 2.5h12v11H2v-11Zm2.5 3 2.5 2.5L4.5 10.5M8.5 10.5h3",
  filter: "M2 2.5h12L9.5 8v5l-3-1.5V8L2 2.5Z",
  "arrow-up": "M8 13V3M4 7l4-4 4 4",
  "arrow-down": "M8 3v10M4 9l4 4 4-4",
  external:
    "M9 2.5h4.5V7M13.5 2.5 7.5 8.5M6 3.5H2.5v10h10V10",
  link: "M6.5 9.5 9.5 6.5M5.2 7.2 3.5 8.9a2.5 2.5 0 0 0 3.6 3.6l1.7-1.7M10.8 8.8l1.7-1.7a2.5 2.5 0 0 0-3.6-3.6L7.2 5.2",
};

export function icon(name: keyof typeof PATHS | string, size = 14, className = ""): string {
  const path = PATHS[name] ?? PATHS.info;
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}" /></svg>`;
}

export function logoSvg(size = 32): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <rect x="3" y="3" width="42" height="42" rx="12" fill="url(#agrad)" />
    <path d="M14 16c0-2.2 4.5-4 10-4s10 1.8 10 4-4.5 4-10 4-10-1.8-10-4Z" stroke="white" stroke-width="2.4" />
    <path d="M14 16v8c0 2.2 4.5 4 10 4s10-1.8 10-4v-8" stroke="white" stroke-width="2.4" opacity=".9" />
    <path d="M14 24v7c0 2.2 4.5 4 10 4s10-1.8 10-4v-7" stroke="white" stroke-width="2.4" opacity=".65" />
    <defs><linearGradient id="agrad" x1="5" y1="5" x2="43" y2="44" gradientUnits="userSpaceOnUse"><stop stop-color="#3FA9F5"/><stop offset="1" stop-color="#6C5CE7"/></linearGradient></defs>
  </svg>`;
}
