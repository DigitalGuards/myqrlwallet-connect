// Shadow-DOM stylesheet. Every color/shape decision is exposed as a CSS
// custom property (set on the element or any ancestor) so dApps can theme
// the modal without forking it; the defaults are the MyQRLWallet dark look.

export const modalStyles = `
:host {
  --qrl-modal-accent: #f97316;
  --qrl-modal-bg: #0f172a;
  --qrl-modal-fg: #e2e8f0;
  --qrl-modal-muted: #94a3b8;
  --qrl-modal-link: #38bdf8;
  --qrl-modal-border: rgba(148, 163, 184, 0.25);
  --qrl-modal-radius: 12px;
  --qrl-modal-backdrop: rgba(2, 6, 23, 0.8);
  --qrl-modal-font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --qrl-modal-z: 2147483000;
}
.backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--qrl-modal-z);
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--qrl-modal-backdrop);
  backdrop-filter: blur(4px);
}
.card {
  width: 100%;
  max-width: 24rem;
  background: var(--qrl-modal-bg);
  color: var(--qrl-modal-fg);
  border: 1px solid var(--qrl-modal-border);
  border-left: 2px solid var(--qrl-modal-accent);
  border-radius: var(--qrl-modal-radius);
  font-family: var(--qrl-modal-font);
  padding: 20px;
  box-sizing: border-box;
  text-align: center;
  outline: none;
}
h2 {
  margin: 0 0 6px;
  font-size: 1.125rem;
  font-weight: 700;
}
.sub {
  margin: 0 0 12px;
  font-size: 0.75rem;
  color: var(--qrl-modal-muted);
  line-height: 1.5;
}
.sub a {
  color: var(--qrl-modal-link);
  text-decoration: none;
}
.sub a:hover {
  text-decoration: underline;
}
.qr {
  display: grid;
  place-items: center;
  margin: 0 auto 12px;
  width: 240px;
  min-height: 240px;
  background: #ffffff;
  border-radius: 8px;
  padding: 8px;
  color: #334155;
  font-size: 0.8rem;
}
.qr svg {
  display: block;
  width: 240px;
  height: 240px;
}
.status {
  margin: 0 0 12px;
  font-size: 0.75rem;
  color: var(--qrl-modal-muted);
  min-height: 1em;
}
.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--qrl-modal-fg);
  background: transparent;
  border: 1px solid var(--qrl-modal-border);
  border-radius: 8px;
  cursor: pointer;
  text-decoration: none;
  font-family: inherit;
}
.btn:hover {
  border-color: var(--qrl-modal-accent);
}
.btn.wide {
  grid-column: 1 / -1;
}
.btn[hidden] {
  display: none;
}
.btn:focus-visible,
.link:focus-visible {
  outline: 2px solid var(--qrl-modal-accent);
  outline-offset: 2px;
}
.hint {
  margin: 0 0 12px;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--qrl-modal-muted);
}
.links {
  display: flex;
  justify-content: center;
  gap: 16px;
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  background: none;
  border: none;
  font: inherit;
  font-size: 0.875rem;
  color: var(--qrl-modal-link);
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
}
.icon {
  width: 14px;
  height: 14px;
  flex: none;
}
.icon svg {
  display: block;
  width: 100%;
  height: 100%;
}
`;

// Minimal inline icons (lucide outlines), stroke follows text color.
const iconSvg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON_EXTERNAL_LINK = iconSvg(
  '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
);

export const ICON_COPY = iconSvg(
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'
);

export const ICON_REFRESH = iconSvg(
  '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
);
