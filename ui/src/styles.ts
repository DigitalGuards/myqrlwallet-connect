// Public theme properties inherit from the host page. Internal fallbacks keep
// the shared QRL Blue palette (deep navy, sky-blue accent, ice-blue links)
// usable in any dApp.

export const modalStyles = `
:host {
  --_qrl-accent: var(--qrl-modal-accent, hsl(199 78% 55%));
  --_qrl-bg: var(--qrl-modal-bg, hsl(222 38% 9%));
  --_qrl-fg: var(--qrl-modal-fg, hsl(210 30% 96%));
  --_qrl-muted: var(--qrl-modal-muted, hsl(215 15% 66%));
  --_qrl-link: var(--qrl-modal-link, hsl(196 60% 78%));
  --_qrl-border: var(--qrl-modal-border, hsl(220 30% 17%));
  --_qrl-radius: var(--qrl-modal-radius, 12px);
  --_qrl-font: var(--qrl-modal-font, 'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif);
  --_qrl-heading-font: var(--qrl-modal-heading-font, 'Sora Variable', var(--_qrl-font));
  font-family: var(--_qrl-font);
  line-height: 1.5;
  color-scheme: dark;
}
*, *::before, *::after {
  box-sizing: border-box;
}
.backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--qrl-modal-z, 2147483000);
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--qrl-modal-backdrop, rgb(0 0 0 / 70%));
  backdrop-filter: blur(4px);
}
.card {
  width: 100%;
  max-width: var(--qrl-modal-width, 24rem);
  max-height: calc(100svh - 32px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  background: var(--_qrl-bg);
  color: var(--_qrl-fg);
  border: 1px solid var(--_qrl-border);
  border-radius: var(--_qrl-radius);
  box-shadow: 0 24px 64px -16px rgb(0 0 0 / 65%);
  text-align: left;
  outline: none;
}
.header {
  padding: 24px 24px 20px;
  border-bottom: 1px solid var(--_qrl-border);
}
.header-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.brand-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: var(--_qrl-accent);
  background: color-mix(in srgb, var(--_qrl-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--_qrl-accent) 20%, transparent);
  border-radius: 8px;
}
.brand-icon .icon {
  width: 20px;
  height: 20px;
}
.close {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--_qrl-muted);
  cursor: pointer;
}
.close:hover {
  color: var(--_qrl-fg);
  background: color-mix(in srgb, var(--_qrl-fg) 6%, transparent);
}
h2 {
  margin: 0 0 8px;
  font-family: var(--_qrl-heading-font);
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.025em;
}
.sub {
  margin: 0;
  font-size: 14px;
  color: var(--_qrl-muted);
  line-height: 1.5;
}
.sub a {
  color: var(--_qrl-link);
  text-decoration: none;
  text-underline-offset: 3px;
}
.sub a:hover {
  text-decoration: underline;
}
.body {
  padding: 24px;
}
.qr {
  display: grid;
  place-items: center;
  margin: 0 auto 16px;
  width: min(100%, 256px);
  aspect-ratio: 1;
  background: #ffffff;
  border-radius: 10px;
  padding: 8px;
  color: #262626;
  font-size: 13px;
}
.qr svg {
  display: block;
  width: 100%;
  height: auto;
}
.status {
  margin: 0 0 20px;
  font-size: 13px;
  color: var(--_qrl-muted);
  min-height: 1em;
  text-align: center;
  overflow-wrap: anywhere;
}
.status:empty {
  display: none;
}
.actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 10px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--_qrl-fg);
  background: color-mix(in srgb, var(--_qrl-fg) 2%, transparent);
  border: 1px solid var(--_qrl-border);
  border-radius: 8px;
  cursor: pointer;
  text-decoration: none;
  text-align: center;
  font-family: inherit;
  transition: border-color 160ms, background-color 160ms, color 160ms;
}
.btn:hover {
  border-color: color-mix(in srgb, var(--_qrl-link) 40%, transparent);
  background: color-mix(in srgb, var(--_qrl-link) 4%, transparent);
}
.btn.wide {
  grid-column: 1 / -1;
}
.btn[hidden] {
  display: none;
}
.btn:focus-visible,
.link:focus-visible,
.close:focus-visible,
.sub a:focus-visible {
  outline: 2px solid var(--_qrl-accent);
  outline-offset: 3px;
}
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--_qrl-muted);
}
.links {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 12px 24px;
  border-top: 1px solid var(--_qrl-border);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0;
  background: none;
  border: none;
  font: inherit;
  font-size: 13px;
  color: var(--_qrl-link);
  cursor: pointer;
  text-underline-offset: 3px;
}
.link.cancel {
  color: var(--_qrl-muted);
}
.link:hover {
  text-decoration: underline;
}
.icon {
  width: 16px;
  height: 16px;
  flex: none;
}
.icon svg {
  display: block;
  width: 100%;
  height: 100%;
}
@media (prefers-reduced-motion: reduce) {
  .btn {
    transition: none;
  }
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

// The MyQRLWallet mark: 13 rounded blocks forming an omega, filled solid
// with the current text color (unlike the stroked lucide outlines above).
export const ICON_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<rect x="5.1" y=".4" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="9.8" y=".4" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="14.5" y=".4" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x=".4" y="5.1" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="19.2" y="5.1" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x=".4" y="9.8" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="19.2" y="9.8" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="5.1" y="14.5" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="14.5" y="14.5" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x=".4" y="19.2" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="5.1" y="19.2" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="14.5" y="19.2" width="4.4" height="4.4" rx=".5"/>' +
  '<rect x="19.2" y="19.2" width="4.4" height="4.4" rx=".5"/>' +
  '</svg>';

export const ICON_CLOSE = iconSvg('<path d="m18 6-12 12M6 6l12 12"/>');
