/**
 * Plugin chrome stylesheet, injected as one `<style>` effect.
 *
 * Every colour is resolved through the Harness theme custom properties
 * (`--dsh-color-*` family with the `--dsw-alias-*` tokens this host version
 * actually defines as the second fallback), so light/dark switching is owned by
 * the Harness. Hard-coded values are only final fallbacks for hosts that expose
 * neither token family, and dark-theme fallbacks are declared under
 * `[data-cad-theme="dark"]` because `var()` fallbacks are resolved at their
 * declaration.
 *
 * Layout rules keep the page inside whatever box the `main` slot gives it:
 * `height: 100%`, `min-height: 0`, `min-width: 0` everywhere, no `100vh`, and
 * one resizable sidebar column. The three.js canvas is positioned inside its
 * own viewport so the renderer never affects layout.
 *
 * @module client/styles
 */

export const CSS = `
.dsh-cad-page {
  --cad-bg: var(--dsh-color-bg-base, var(--dsw-alias-bg-base, #ffffff));
  --cad-bg-layer: var(--dsh-color-bg-layer-1, var(--dsw-alias-bg-layer-1, #f7f8fa));
  --cad-bg-elevated: var(--dsh-color-bg-overlay, var(--dsw-alias-bg-overlay, #ffffff));
  --cad-bg-hover: var(--dsh-color-bg-layer-2, var(--dsw-alias-bg-layer-2, #eef1f5));
  --cad-border: var(--dsh-color-border-l1, var(--dsw-alias-border-l1, #e3e6ea));
  --cad-text: var(--dsh-color-label-primary, var(--dsw-alias-label-primary, #1b1f24));
  --cad-text-2: var(--dsh-color-label-secondary, var(--dsw-alias-label-secondary, #66707c));
  --cad-accent: var(--dsh-color-brand-primary, var(--dsw-alias-brand-primary, #3b6ef6));
  --cad-warn: var(--dsh-color-state-warn-primary, var(--dsw-alias-state-warn-primary, #b26a00));
  --cad-error: var(--dsh-color-state-error-primary, var(--dsw-alias-state-error-primary, #d33a3a));
  --cad-success: var(--dsh-color-state-success-primary, var(--dsw-alias-state-success-primary, #1a7f37));
  --cad-canvas-from: #eef2f8;
  --cad-canvas-to: #dbe2ec;
  --cad-shadow: 0 6px 22px rgba(15, 23, 42, 0.12);

  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
  background: var(--cad-bg);
  color: var(--cad-text);
  font-family: inherit;
  font-size: 12px;
  overflow: hidden;
}
.dsh-cad-page[data-cad-theme="dark"] {
  --cad-bg: var(--dsh-color-bg-base, var(--dsw-alias-bg-base, #121317));
  --cad-bg-layer: var(--dsh-color-bg-layer-1, var(--dsw-alias-bg-layer-1, #181a1f));
  --cad-bg-elevated: var(--dsh-color-bg-overlay, var(--dsw-alias-bg-overlay, #1f2228));
  --cad-bg-hover: var(--dsh-color-bg-layer-2, var(--dsw-alias-bg-layer-2, #24272e));
  --cad-border: var(--dsh-color-border-l1, var(--dsw-alias-border-l1, #2c3038));
  --cad-text: var(--dsh-color-label-primary, var(--dsw-alias-label-primary, #e8ebef));
  --cad-text-2: var(--dsh-color-label-secondary, var(--dsw-alias-label-secondary, #9aa4b1));
  --cad-canvas-from: #23262d;
  --cad-canvas-to: #14161a;
  --cad-shadow: 0 6px 22px rgba(0, 0, 0, 0.45);
}
.dsh-cad-page *, .dsh-cad-page *::before, .dsh-cad-page *::after { box-sizing: border-box; }
/* Automation hook: readable by tests, invisible and silent for users. */
.dsh-cad-testhook {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ------------------------------------------------------------------ header */
.dsh-cad-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--cad-border);
  min-height: 44px;
}
.dsh-cad-title { font-size: 13px; font-weight: 600; white-space: nowrap; }
.dsh-cad-sub {
  color: var(--cad-text-2);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dsh-cad-spacer { flex: 1 1 auto; min-width: 4px; }
.dsh-cad-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 16px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--cad-border);
  color: var(--cad-text-2);
  white-space: nowrap;
}
.dsh-cad-badge.current { color: var(--cad-accent); border-color: currentColor; }
.dsh-cad-badge.warn { color: var(--cad-warn); border-color: currentColor; }
.dsh-cad-badge.error { color: var(--cad-error); border-color: currentColor; }
.dsh-cad-badge.ok { color: var(--cad-success); border-color: currentColor; }
.dsh-cad-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor; display: inline-block;
}

/* ------------------------------------------------------------------ buttons */
.dsh-cad-button {
  appearance: none;
  border: 1px solid var(--cad-border);
  background: var(--cad-bg-elevated);
  color: var(--cad-text);
  border-radius: 7px;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 3px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-cad-button:hover:not(:disabled) { background: var(--cad-bg-hover); }
.dsh-cad-button:active:not(:disabled) { transform: translateY(1px); }
.dsh-cad-button:disabled { opacity: 0.45; cursor: default; }
.dsh-cad-button.primary {
  background: var(--cad-accent);
  border-color: var(--cad-accent);
  color: #ffffff;
}
.dsh-cad-button.primary:hover:not(:disabled) { filter: brightness(1.08); }
.dsh-cad-button.ghost { background: transparent; }
.dsh-cad-button.small { font-size: 11px; padding: 1px 7px; }
.dsh-cad-page :focus-visible {
  outline: 2px solid var(--cad-accent);
  outline-offset: 1px;
}

/* -------------------------------------------------------------------- body */
.dsh-cad-body { flex: 1 1 auto; display: flex; min-height: 0; min-width: 0; }

/* ------------------------------------------------------------------- rails */
.dsh-cad-side {
  flex: 0 0 clamp(196px, 22%, 288px);
  width: clamp(196px, 22%, 288px);
  min-height: 0;
  min-width: 0;
  border-right: 1px solid var(--cad-border);
  background: var(--cad-bg-layer);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}
.dsh-cad-side::-webkit-scrollbar,
.dsh-cad-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.dsh-cad-side::-webkit-scrollbar-thumb,
.dsh-cad-scroll::-webkit-scrollbar-thumb {
  background: var(--cad-border);
  border-radius: 999px;
}
.dsh-cad-section { border-bottom: 1px solid var(--cad-border); padding: 8px 8px 10px; }
.dsh-cad-section:last-child { border-bottom: none; }
.dsh-cad-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--cad-text-2);
  padding: 0 2px 6px;
}
.dsh-cad-section-title .dsh-cad-count {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}

/* -------------------------------------------------------------- model list */
.dsh-cad-list { display: flex; flex-direction: column; gap: 2px; }
.dsh-cad-item {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font: inherit;
  border-radius: 7px;
  padding: 5px 8px;
  cursor: pointer;
  min-width: 0;
}
.dsh-cad-item:hover { background: var(--cad-bg-hover); }
.dsh-cad-item[aria-current="true"] {
  background: var(--cad-bg-hover);
  border-color: var(--cad-border);
}
.dsh-cad-item-name {
  display: block;
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-cad-item-meta {
  display: flex;
  gap: 8px;
  font-size: 10.5px;
  color: var(--cad-text-2);
  overflow: hidden;
  white-space: nowrap;
}
.dsh-cad-item-meta .dsh-cad-item-error { color: var(--cad-error); }
.dsh-cad-item-meta .dsh-cad-item-warn { color: var(--cad-warn); }
.dsh-cad-loading { padding: 6px 8px; color: var(--cad-text-2); font-size: 11.5px; line-height: 1.5; }
.dsh-cad-loading p { margin: 0 0 4px; }
.dsh-cad-loading .dsh-cad-muted { color: var(--cad-text-2); }

/* ---------------------------------------------------------------- geometry */
.dsh-cad-dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; align-items: baseline; }
.dsh-cad-dl dt { color: var(--cad-text-2); font-size: 11px; white-space: nowrap; }
.dsh-cad-dl dd {
  margin: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.dsh-cad-dl dd code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }

/* ---------------------------------------------------------------- warnings */
.dsh-cad-checks { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.dsh-cad-check {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--cad-text-2);
}
.dsh-cad-check .dsh-cad-check-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  flex: 0 0 auto;
}
.dsh-cad-check.pass .dsh-cad-check-id { color: var(--cad-success); }
.dsh-cad-check.warn .dsh-cad-check-id { color: var(--cad-warn); }
.dsh-cad-check.fail .dsh-cad-check-id { color: var(--cad-error); }
.dsh-cad-warning-list { margin: 6px 0 0; padding: 0 0 0 16px; font-size: 10.5px; line-height: 1.5; color: var(--cad-warn); }
.dsh-cad-warning-list li { margin: 0 0 2px; }
.dsh-cad-error-list { margin: 6px 0 0; padding: 0 0 0 16px; font-size: 10.5px; line-height: 1.5; color: var(--cad-error); }

/* -------------------------------------------------------------- history */
.dsh-cad-history { display: flex; flex-direction: column; gap: 2px; }
.dsh-cad-history-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font: inherit;
  border-radius: 6px;
  padding: 3px 7px;
  cursor: pointer;
  font-size: 11px;
  text-align: left;
}
.dsh-cad-history-row:hover:not(:disabled) { background: var(--cad-bg-hover); }
.dsh-cad-history-row:disabled { cursor: default; opacity: 0.55; }
.dsh-cad-history-row[aria-current="true"] { border-color: var(--cad-border); background: var(--cad-bg-hover); }
.dsh-cad-history-row .dsh-cad-rev {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
}
.dsh-cad-history-row .dsh-cad-rev-status { margin-left: auto; color: var(--cad-text-2); font-size: 10px; }
.dsh-cad-history-row .dsh-cad-rev-status.failed { color: var(--cad-error); }
.dsh-cad-history-row .dsh-cad-rev-status.built { color: var(--cad-success); }

/* ----------------------------------------------------------------- main */
.dsh-cad-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.dsh-cad-viewport {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
  cursor: grab;
  background:
    radial-gradient(120% 100% at 50% 0%, var(--cad-canvas-from) 0%, var(--cad-canvas-to) 100%);
  outline: none;
}
.dsh-cad-viewport.is-dragging { cursor: grabbing; }
.dsh-cad-viewport:focus-visible { outline: 2px solid var(--cad-accent); outline-offset: -2px; }
.dsh-cad-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}

/* ------------------------------------------------------- viewer overlays */
.dsh-cad-overlay { position: absolute; z-index: 5; pointer-events: none; }
.dsh-cad-overlay > * { pointer-events: auto; }
.dsh-cad-overlay.top-left { top: 10px; left: 10px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.dsh-cad-overlay.top-right { top: 10px; right: 10px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.dsh-cad-overlay.bottom { bottom: 10px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 24px); }
.dsh-cad-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-cad-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--cad-text);
  background: color-mix(in srgb, var(--cad-bg-elevated) 82%, transparent);
  background: var(--cad-bg-elevated);
  border: 1px solid var(--cad-border);
  box-shadow: var(--cad-shadow);
  white-space: nowrap;
}
.dsh-cad-chip .dsh-cad-chip-label { color: var(--cad-text-2); }
.dsh-cad-chip .dsh-cad-chip-value { font-variant-numeric: tabular-nums; }
.dsh-cad-hint {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--cad-text-2);
  background: var(--cad-bg-elevated);
  border: 1px solid var(--cad-border);
  box-shadow: var(--cad-shadow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-cad-hint kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  padding: 0 3px;
  border-radius: 4px;
  border: 1px solid var(--cad-border);
  background: var(--cad-bg-layer);
}

/* --------------------------------------------------------- viewer states */
.dsh-cad-state {
  position: absolute;
  z-index: 6;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: var(--cad-canvas-to);
  background: color-mix(in srgb, var(--cad-canvas-to) 55%, transparent);
}
.dsh-cad-state-card {
  max-width: min(460px, 100%);
  background: var(--cad-bg-elevated);
  border: 1px solid var(--cad-border);
  border-radius: 12px;
  box-shadow: var(--cad-shadow);
  padding: 14px 16px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--cad-text);
}
.dsh-cad-state-card strong { display: block; font-size: 13px; margin-bottom: 4px; }
.dsh-cad-state-card p { margin: 0 0 8px; color: var(--cad-text-2); }
.dsh-cad-state-card .dsh-cad-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
.dsh-cad-state-card.error { border-color: var(--cad-error); }
.dsh-cad-state-card.error strong { color: var(--cad-error); }
.dsh-cad-state-card.warn { border-color: var(--cad-warn); }
.dsh-cad-state-card.warn strong { color: var(--cad-warn); }
.dsh-cad-spinner {
  display: inline-block;
  width: 12px; height: 12px;
  margin-right: 6px;
  vertical-align: -2px;
  border-radius: 50%;
  border: 2px solid var(--cad-border);
  border-top-color: var(--cad-accent);
  animation: dsh-cad-spin 0.9s linear infinite;
}
@keyframes dsh-cad-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dsh-cad-spinner { animation-duration: 2.4s; }
  .dsh-cad-button:active:not(:disabled) { transform: none; }
}

/* ------------------------------------------------------------ inspect card */
.dsh-cad-inspect {
  position: absolute;
  z-index: 7;
  top: 10px;
  right: 10px;
  width: min(232px, calc(100% - 20px));
  background: var(--cad-bg-elevated);
  border: 1px solid var(--cad-border);
  border-radius: 10px;
  box-shadow: var(--cad-shadow);
  padding: 8px 10px 10px;
  font-size: 11px;
}
.dsh-cad-inspect-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
}
.dsh-cad-inspect-head strong { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-cad-inspect-head .dsh-cad-spacer { flex: 1 1 auto; }
.dsh-cad-inspect .dsh-cad-dl { gap: 1px 8px; }
.dsh-cad-inspect .dsh-cad-dl dd { font-size: 10.5px; }
.dsh-cad-toast {
  position: absolute;
  z-index: 9;
  right: 12px;
  bottom: 40px;
  max-width: min(320px, calc(100% - 24px));
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--cad-text);
  background: var(--cad-bg-elevated);
  border: 1px solid var(--cad-border);
  box-shadow: var(--cad-shadow);
}
.dsh-cad-banner {
  position: absolute;
  z-index: 8;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  width: min(520px, calc(100% - 24px));
  background: var(--cad-bg-elevated);
  border: 1px solid var(--cad-warn);
  border-radius: 10px;
  box-shadow: var(--cad-shadow);
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.5;
}
.dsh-cad-banner.error { border-color: var(--cad-error); }
.dsh-cad-banner strong { display: block; margin-bottom: 2px; }
.dsh-cad-banner p { margin: 0 0 6px; color: var(--cad-text-2); }
.dsh-cad-banner .dsh-cad-actions { display: flex; gap: 6px; justify-content: flex-end; }

/* --------------------------------------------------------------- footer */
.dsh-cad-status {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 10px;
  min-height: 24px;
  border-top: 1px solid var(--cad-border);
  color: var(--cad-text-2);
  font-size: 10.5px;
  overflow: hidden;
  white-space: nowrap;
}
.dsh-cad-status .dsh-cad-spacer { flex: 1 1 auto; }
.dsh-cad-status code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
}
.dsh-cad-status .dsh-cad-error-text { color: var(--cad-error); overflow: hidden; text-overflow: ellipsis; }
`
