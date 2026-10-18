// Conduit Control UI: the HTML shell, styles and browser script served by the
// local control panel (src/app/control-panel.ts).
//
// Design notes:
// - Tokens live on :root with a dark set applied by prefers-color-scheme or an
//   explicit data-theme toggle (remembered per browser in localStorage).
// - Consent is the core concept, so approvals render as cards that show the
//   source, declared permissions and every action before the decision buttons.
// - `?demo=1` switches the client to in-memory sample data (see the demo section
//   of CLIENT_JS). Demo mode never calls the local API or touches the clipboard.
// - CLIENT_JS is plain browser JavaScript inside a template literal, so it avoids
//   backticks, dollar-brace sequences and backslashes.

export interface AppHtmlOptions {
  /** Default allowed root offered in the session form and handshake. */
  cwd: string;
  /** conduit:// link that asks Conduit to prepare the extension alpha install. */
  extensionInstallUrl: string;
}

const DARK_TOKENS = `
    color-scheme: dark;
    --bg: #0e1012;
    --bg-side: #121518;
    --surface: #171a1e;
    --surface-2: #1b1f24;
    --line: #262b31;
    --line-strong: #353b43;
    --ink: #eceef0;
    --ink-2: #c8ccd1;
    --muted: #949aa3;
    --accent: #2fc4a6;
    --accent-hover: #4fd6bb;
    --accent-ink: #052620;
    --accent-soft: rgba(47, 196, 166, 0.11);
    --accent-line: rgba(47, 196, 166, 0.34);
    --warn: #f0b04a;
    --warn-soft: rgba(240, 176, 74, 0.10);
    --warn-line: rgba(240, 176, 74, 0.34);
    --danger: #f27a6e;
    --danger-soft: rgba(242, 122, 110, 0.10);
    --danger-line: rgba(242, 122, 110, 0.36);
    --code-bg: #0a0c0e;
    --code-ink: #cfe6df;
    --focus: 0 0 0 3px rgba(47, 196, 166, 0.32);
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 28px rgba(0, 0, 0, 0.25);
  `;

const ICONS: Record<string, string> = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/></svg>',
  approvals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  sessions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  runs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
  diagnostics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9V7a3 3 0 0 1 6 0v2"/><rect x="7" y="9" width="10" height="11" rx="5"/><path d="M4 13h3M17 13h3M5 19l2.5-2M19 19l-2.5-2M12 13v4"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/></svg>'
};

const STYLES = `:root {
  color-scheme: light;
  --bg: #f5f4f0;
  --bg-side: #eeece6;
  --surface: #ffffff;
  --surface-2: #faf9f6;
  --line: #e4e1d8;
  --line-strong: #d3cfc4;
  --ink: #17181b;
  --ink-2: #3a3d44;
  --muted: #6b6f78;
  --accent: #0f766e;
  --accent-hover: #0b5f58;
  --accent-ink: #ffffff;
  --accent-soft: #e2f1ee;
  --accent-line: #a9d7ce;
  --warn: #9a5507;
  --warn-soft: #fcf2df;
  --warn-line: #eccb8f;
  --danger: #b42318;
  --danger-soft: #fdecea;
  --danger-line: #f1b8b2;
  --code-bg: #14171a;
  --code-ink: #d6ece6;
  --focus: 0 0 0 3px rgba(15, 118, 110, 0.28);
  --shadow: 0 1px 2px rgba(23, 24, 27, 0.04), 0 10px 28px rgba(23, 24, 27, 0.06);
  --radius: 14px;
  --radius-sm: 9px;
  --font: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { __DARK__ }
}
:root[data-theme="dark"] { __DARK__ }

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--font); font-feature-settings: "cv11", "ss01"; -webkit-font-smoothing: antialiased; }
button, input, select { font: inherit; color: inherit; }
a { color: var(--accent); }
code, pre, .mono { font-family: var(--mono); font-size: 12.5px; }
[hidden] { display: none !important; }
.hidden { display: none !important; }
:focus-visible { outline: none; box-shadow: var(--focus); border-radius: 8px; }

.demo-banner { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 9px 20px; background: var(--warn-soft); border-bottom: 1px solid var(--warn-line); color: var(--ink-2); font-size: 13px; }
.demo-banner strong { color: var(--warn); }
.demo-banner a { margin-left: auto; font-weight: 600; color: var(--warn); }
.demo-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; background: var(--warn); color: #fff; font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }

.shell { min-height: 100vh; display: grid; grid-template-columns: 256px minmax(0, 1fr); }
.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 26px; padding: 22px 16px; background: var(--bg-side); border-right: 1px solid var(--line); }
body.demo .sidebar { top: 40px; height: calc(100vh - 40px); }
.brand { display: flex; align-items: center; gap: 11px; padding: 0 6px; }
.brand-mark { width: 34px; height: 34px; flex: none; }
.brand-name { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.brand-sub { color: var(--muted); font-size: 12px; }
.nav { display: grid; gap: 2px; }
.nav button { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: transparent; padding: 9px 10px; border-radius: 9px; color: var(--ink-2); cursor: pointer; text-align: left; font-weight: 500; }
.nav button svg { width: 18px; height: 18px; flex: none; color: var(--muted); pointer-events: none; }
.nav button span { pointer-events: none; }
.nav button:hover { background: color-mix(in srgb, var(--surface) 60%, transparent); }
.nav button.active { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), inset 0 0 0 1px var(--line); font-weight: 600; }
.nav button.active svg { color: var(--accent); }
.count { margin-left: auto; min-width: 22px; padding: 1px 7px; border-radius: 999px; background: var(--warn); color: #fff; font-size: 11.5px; font-weight: 700; text-align: center; }
.side-foot { margin-top: auto; display: grid; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-2); }
.side-foot p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
.mode-chip { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); flex: none; }
.dot.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.dot.off { background: var(--muted); box-shadow: 0 0 0 3px var(--line); }
.foot-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12.5px; }
.link-btn { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; font-weight: 600; font-size: 12.5px; text-decoration: none; }

main { padding: 30px clamp(18px, 4vw, 44px) 80px; max-width: 1240px; width: 100%; min-width: 0; }
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 26px; }
.page-head > div:first-child { flex: 1 1 auto; min-width: 0; }
.page-head > .toolbar { flex: 0 0 auto; }
h1 { font-size: 28px; line-height: 1.15; margin: 0 0 6px; letter-spacing: -0.02em; font-weight: 700; }
h2 { font-size: 15px; margin: 0; letter-spacing: -0.005em; font-weight: 650; }
h3 { font-size: 16px; margin: 0; letter-spacing: -0.01em; font-weight: 650; }
h4 { margin: 0 0 8px; font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
.subtle { color: var(--muted); font-size: 13px; }
.lede { color: var(--muted); max-width: 620px; margin: 0; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); padding: 0 13px; border-radius: 9px; cursor: pointer; font-weight: 550; font-size: 13.5px; text-decoration: none; white-space: nowrap; box-shadow: 0 1px 1px rgba(0, 0, 0, 0.03); }
.btn:hover { border-color: var(--muted); }
.btn svg { width: 16px; height: 16px; pointer-events: none; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn.danger { color: var(--danger); border-color: var(--danger-line); }
.btn.danger:hover { background: var(--danger-soft); border-color: var(--danger); }
.btn.ghost { border-color: transparent; background: transparent; box-shadow: none; }
.btn.small { min-height: 30px; padding: 0 10px; font-size: 12.5px; }
.btn[disabled] { opacity: 0.5; cursor: not-allowed; }

.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
.stat { padding: 16px 18px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.stat b { display: block; font-size: 28px; line-height: 1.1; letter-spacing: -0.02em; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 12.5px; }
.stat.attention { border-color: var(--warn-line); background: linear-gradient(180deg, var(--warn-soft), var(--surface) 85%); }
.stat.attention b { color: var(--warn); }

.cols { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 18px; align-items: start; }
.cols > div { min-width: 0; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 18px; overflow: hidden; }
.panel-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.panel-head .subtle { margin-top: 2px; }
.panel-body { padding: 16px 18px; }
.panel-body.flush { padding: 0; }

.service { display: flex; align-items: flex-start; gap: 12px; padding: 13px 18px; border-bottom: 1px solid var(--line); }
.service:last-child { border-bottom: 0; }
.service .dot { margin-top: 7px; }
.service div { min-width: 0; }
.service strong { display: block; font-weight: 600; }
.service .mono { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }

.queue-item { display: flex; align-items: center; gap: 14px; padding: 13px 18px; border-bottom: 1px solid var(--line); }
.queue-item:last-child { border-bottom: 0; }
.queue-item .grow { flex: 1; min-width: 0; }
.queue-item strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.empty { display: grid; justify-items: start; gap: 4px; color: var(--muted); padding: 22px 18px; }
.empty strong { color: var(--ink); font-weight: 600; }

.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 650; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink-2); white-space: nowrap; }
.badge.ok { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent); }
.badge.warn { background: var(--warn-soft); border-color: var(--warn-line); color: var(--warn); }
.badge.danger { background: var(--danger-soft); border-color: var(--danger-line); color: var(--danger); }

.consent { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 18px; overflow: hidden; }
.consent::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--warn); }
.consent.decided::before { background: var(--line-strong); }
.consent.ran::before { background: var(--accent); }
.consent-head { padding: 18px 22px 14px 24px; display: grid; gap: 8px; }
.consent-tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.consent-head p { margin: 0; color: var(--ink-2); }
.consent-meta { color: var(--muted); font-size: 12px; }
.consent-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--line); }
.consent-grid > section { padding: 14px 22px 16px 24px; border-right: 1px solid var(--line); min-width: 0; }
.consent-grid > section:last-child { border-right: 0; }
.consent-grid p { margin: 0; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-family: var(--mono); font-size: 11.5px; padding: 2px 8px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-2); }
.action-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.action-list li { display: grid; gap: 1px; }
.action-list code { color: var(--ink); font-weight: 600; }
.action-list span { color: var(--muted); font-size: 12.5px; }
.policy-note { display: flex; gap: 10px; align-items: flex-start; margin: 0; padding: 12px 22px 12px 24px; background: var(--accent-soft); border-top: 1px solid var(--accent-line); color: var(--ink-2); font-size: 13px; }
.policy-note svg { width: 17px; height: 17px; flex: none; margin-top: 1px; color: var(--accent); }
.consent details { border-top: 1px solid var(--line); }
.consent summary { cursor: pointer; padding: 10px 22px 10px 24px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
.consent details pre { margin: 0 22px 14px 24px; }
.consent-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 13px 22px 13px 24px; border-top: 1px solid var(--line); background: var(--surface-2); }
.consent-foot .decide { display: flex; gap: 8px; margin-left: auto; }
.consent-foot .btn { min-height: 38px; }
.history { display: grid; }
.history-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 14px; align-items: center; padding: 11px 18px; border-bottom: 1px solid var(--line); }
.history-row:last-child { border-bottom: 0; }
.history-row strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }

pre { white-space: pre-wrap; word-break: break-word; overflow: auto; margin: 0; background: var(--code-bg); color: var(--code-ink); border-radius: 10px; padding: 13px 14px; line-height: 1.55; max-height: 420px; }
details.raw summary { cursor: pointer; color: var(--muted); font-size: 12.5px; font-weight: 600; padding: 2px 0 10px; }

form.inline { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 220px auto; gap: 12px; align-items: end; }
label { display: grid; gap: 6px; color: var(--ink-2); font-size: 12.5px; font-weight: 600; }
input, select { border: 1px solid var(--line-strong); border-radius: 9px; padding: 0 11px; min-height: 38px; background: var(--surface); color: var(--ink); min-width: 0; width: 100%; }
input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: var(--focus); }
.hint { margin: 12px 0 0; color: var(--muted); font-size: 12.5px; }
.hint b { color: var(--ink-2); }

.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 12px 18px; font-size: 13px; vertical-align: middle; }
th { color: var(--muted); font-weight: 600; font-size: 11.5px; letter-spacing: 0.05em; text-transform: uppercase; background: var(--surface-2); }
tr:last-child td { border-bottom: 0; }
td strong { font-weight: 600; }
td .mono { color: var(--muted); font-size: 12px; }
.nonce { display: inline-block; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.cell-actions { text-align: right; white-space: nowrap; }

.toast { position: fixed; right: 20px; bottom: 20px; z-index: 30; max-width: min(440px, calc(100vw - 40px)); padding: 11px 15px; border-radius: 11px; background: var(--ink); color: var(--bg); font-size: 13px; box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22); opacity: 0; transform: translateY(8px); transition: opacity 0.18s ease, transform 0.18s ease; pointer-events: none; }
.toast.show { opacity: 1; transform: none; }
.toast.error { background: var(--danger); color: #fff; }

@media (max-width: 1080px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cols { grid-template-columns: minmax(0, 1fr); }
  .consent-grid { grid-template-columns: minmax(0, 1fr); }
  .consent-grid > section { border-right: 0; border-bottom: 1px solid var(--line); }
  .consent-grid > section:last-child { border-bottom: 0; }
  form.inline { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .page-head > .toolbar { flex: 0 1 auto; }
}
@media (max-width: 860px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidebar { min-width: 0; }
  .sidebar, body.demo .sidebar { position: static; height: auto; gap: 14px; padding: 14px 16px 10px; border-right: 0; border-bottom: 1px solid var(--line); }
  .nav { display: flex; gap: 4px; overflow-x: auto; margin: 0 -4px; padding: 0 4px 2px; scrollbar-width: none; }
  .nav button { width: auto; flex: none; padding: 8px 11px; }
  .side-foot { display: none; }
  .page-head { flex-direction: column; align-items: stretch; gap: 16px; }
  .toolbar { justify-content: flex-start; }
  main { padding-top: 22px; }
}
@media (max-width: 560px) {
  h1 { font-size: 24px; }
  .stats { gap: 10px; }
  .stat { padding: 13px 14px; }
  .stat b { font-size: 24px; }
  .toolbar .btn { flex: 1 1 calc(50% - 8px); min-width: 0; white-space: normal; padding: 6px 10px; line-height: 1.25; }
  .demo-banner { font-size: 12.5px; padding: 9px 16px; }
  .stat b { overflow-wrap: anywhere; }
  #modeStat { font-size: 20px; line-height: 1.4; }
  form.inline { grid-template-columns: minmax(0, 1fr); }
  .page-head > .toolbar { flex: 0 1 auto; }
  .consent-head, .consent-grid > section, .policy-note, .consent-foot, .consent summary { padding-left: 18px; padding-right: 16px; }
  .consent details pre { margin: 0 16px 14px 18px; }
  .consent-foot .decide { width: 100%; }
  .consent-foot .decide .btn { flex: 1; }
  table.stack thead { display: none; }
  table.stack, table.stack tbody, table.stack tr, table.stack td { display: block; width: 100%; }
  table.stack tr { padding: 10px 0; border-bottom: 1px solid var(--line); }
  table.stack tr:last-child { border-bottom: 0; }
  table.stack td { border: 0; padding: 4px 16px; display: flex; justify-content: space-between; gap: 16px; text-align: right; }
  table.stack td::before { content: attr(data-label); color: var(--muted); font-size: 12px; font-weight: 600; text-align: left; flex: none; }
  table.stack td.first { display: block; text-align: left; padding-bottom: 6px; }
  table.stack td.first::before { content: none; }
  table.stack td.cell-actions { justify-content: flex-end; }
  table.stack td.cell-actions::before { content: none; }
  .history-row { grid-template-columns: minmax(0, 1fr) auto; }
  .history-row .when { display: none; }
}
`.split('__DARK__').join(DARK_TOKENS);

const BODY = `<div class="demo-banner" id="demoBanner" hidden>
  <span class="demo-pill">Demo data</span>
  <span><strong>Sample sessions, approvals and runs.</strong> Nothing on this page reads or changes your machine; decisions are simulated in this tab.</span>
  <a href="./" id="exitDemo">Exit demo</a>
</div>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#0f766e"/><circle cx="256" cy="256" r="154" fill="none" stroke="#d8efe9" stroke-width="34"/><path d="M256 112 376 256 256 400 136 256Z" fill="#d8efe9"/><path d="M256 174 324 256 256 338 188 256Z" fill="#0f766e"/></svg>
      <div>
        <div class="brand-name">Conduit</div>
        <div class="brand-sub">Local consent control</div>
      </div>
    </div>
    <nav class="nav" aria-label="Sections">
      <button class="active" data-view="overview" type="button">__ICON_overview__<span>Overview</span></button>
      <button data-view="approvals" type="button">__ICON_approvals__<span>Approvals</span><span class="count" id="approvalCount" hidden>0</span></button>
      <button data-view="sessions" type="button">__ICON_sessions__<span>Sessions</span></button>
      <button data-view="runs" type="button">__ICON_runs__<span>Runs</span></button>
      <button data-view="diagnostics" type="button">__ICON_diagnostics__<span>Report Bug</span></button>
    </nav>
    <div class="side-foot">
      <div class="mode-chip"><span class="dot"></span><span><span id="mode">Compliance</span> mode</span></div>
      <p>Exact clipboard envelopes only. Embedded blocks in prose are text, not consent. Listening on loopback only.</p>
      <div class="foot-row">
        <button class="link-btn" id="themeToggle" type="button">Toggle theme</button>
        <a class="link-btn" id="demoLink" href="?demo=1">View demo data</a>
      </div>
    </div>
  </aside>
  <main>
    <header class="page-head">
      <div>
        <h1 id="title">Overview</h1>
        <p class="lede" id="subtitle">Compliance mode, exact clipboard envelopes only.</p>
      </div>
      <div class="toolbar">
        <button class="btn" id="refresh" type="button">__ICON_refresh__Refresh</button>
        <button class="btn" id="reportBug" type="button">Report Bug</button>
        <button class="btn" id="copyHandshake" type="button">Copy Agent Handshake</button>
        <button class="btn primary" id="checkClipboard" type="button">Check Clipboard Once</button>
      </div>
    </header>

    <section id="overviewView">
      <div class="stats">
        <div class="stat" id="pendingStat"><b id="pendingCount">0</b><span>waiting for your decision</span></div>
        <div class="stat"><b id="sessionCount">0</b><span>active sessions</span></div>
        <div class="stat"><b id="runCount">0</b><span>recent runs</span></div>
        <div class="stat"><b id="modeStat">Compliance</b><span>clipboard mode</span></div>
      </div>
      <div class="cols">
        <div>
          <div class="panel">
            <div class="panel-head">
              <div><h2>Needs your decision</h2><div class="subtle">Requests stop here until you approve or deny them.</div></div>
              <button class="btn small" data-view="approvals" type="button">Open approvals</button>
            </div>
            <div class="panel-body flush" id="queuePreview"></div>
          </div>
          <div class="panel">
            <div class="panel-head">
              <div><h2>Extension Bridge</h2><div class="subtle">Optional paired ChatGPT transport on 127.0.0.1:3333.</div></div>
              <div class="toolbar">
                <a class="btn small" href="__EXTENSION_INSTALL_URL__" id="downloadExtension">Download Extension</a>
                <button class="btn small" id="retryOutbound" type="button">Retry Outbound</button>
              </div>
            </div>
            <div class="panel-body">
              <p class="subtle" id="bridgeAvailability" style="margin:0 0 12px">Checking bridge...</p>
              <details class="raw"><summary>Bridge health JSON</summary><pre id="bridgeJson">{}</pre></details>
            </div>
          </div>
        </div>
        <div>
          <div class="panel">
            <div class="panel-head"><div><h2>Local services</h2><div class="subtle">Everything binds to loopback.</div></div></div>
            <div class="panel-body flush" id="services"></div>
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Runtime</h2></div>
            <div class="panel-body"><details class="raw"><summary>Status JSON</summary><pre id="statusJson">{}</pre></details></div>
          </div>
        </div>
      </div>
    </section>

    <section id="approvalsView" class="hidden">
      <div id="approvalsTable"></div>
      <div class="panel" id="historyPanel" hidden>
        <div class="panel-head"><div><h2>Recent decisions</h2><div class="subtle">Every decision records where it was made.</div></div></div>
        <div class="panel-body flush history" id="historyList"></div>
      </div>
    </section>

    <section id="sessionsView" class="hidden">
      <div class="panel">
        <div class="panel-head"><div><h2>Pair a session</h2><div class="subtle">Creates a session, a one-shot nonce and a starter envelope.</div></div></div>
        <div class="panel-body">
          <form id="createSession" class="inline">
            <label>Label<input name="label" value="Clipboard session" autocomplete="off"></label>
            <label>Allowed root<input name="root" id="rootInput" value="" autocomplete="off" spellcheck="false"></label>
            <label>Permission profile<select name="profile" id="profileSelect"><option>read-only</option><option>edit-with-confirmation</option><option>shell-manual</option></select></label>
            <button class="btn primary" type="submit">Create session</button>
          </form>
          <p class="hint" id="profileHint"></p>
          <p class="hint" id="sessionStatus"></p>
        </div>
      </div>
      <div class="panel hidden" id="starterPanel">
        <div class="panel-head"><div><h2>Starter Envelope</h2><div class="subtle">Copy only the fenced block. Prose around it is not consent.</div></div><button class="btn small" data-copy="starterEnvelope" type="button">Copy</button></div>
        <div class="panel-body"><pre id="starterEnvelope"></pre></div>
      </div>
      <div class="panel hidden" id="handshakePanel">
        <div class="panel-head"><div><h2>Agent handshake</h2><div class="subtle" id="handshakeNote">Paste this into the chat that should drive the session.</div></div><button class="btn small" data-copy="handshakeText" type="button">Copy</button></div>
        <div class="panel-body"><pre id="handshakeText"></pre></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h2>Sessions</h2><div class="subtle">Revoking a session invalidates its nonce immediately.</div></div></div>
        <div class="panel-body flush" id="sessionsTable"></div>
      </div>
    </section>

    <section id="runsView" class="hidden">
      <div class="panel">
        <div class="panel-head"><div><h2>Recent runs</h2><div class="subtle">Stored locally under the Conduit state directory.</div></div></div>
        <div class="panel-body flush" id="runsTable"></div>
      </div>
      <div class="panel hidden" id="resultPanel">
        <div class="panel-head"><h2 id="resultTitle">Result</h2><button class="btn small" data-copy="runResult" type="button">Copy</button></div>
        <div class="panel-body"><pre id="runResult"></pre></div>
      </div>
    </section>

    <section id="diagnosticsView" class="hidden">
      <div class="panel">
        <div class="panel-head">
          <div><h2>Bug Report</h2><div class="subtle">Preview exactly what would be shared.</div></div>
          <button class="btn primary" id="copyDiagnostics" type="button">Copy Diagnostics</button>
        </div>
        <div class="panel-body">
          <p class="subtle" style="margin-top:0">Preview the redacted diagnostic bundle before attaching it to a report. It excludes clipboard contents, request payloads, file contents, session nonces, API keys, environment variables, and credentials by default.</p>
          <pre id="diagnosticsJson">{}</pre>
        </div>
      </div>
    </section>
  </main>
</div>
<div class="toast" id="appStatus" role="status" aria-live="polite"></div>
`;

export function renderAppHtml(options: AppHtmlOptions): string {
  const config = JSON.stringify({ cwd: options.cwd }).replace(/</g, '\\u003c');
  let body = BODY.replace('__EXTENSION_INSTALL_URL__', () => escapeHtml(options.extensionInstallUrl));
  for (const [name, svg] of Object.entries(ICONS)) {
    body = body.split(`__ICON_${name}__`).join(svg);
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Conduit Control</title>
  <script>try { var t = localStorage.getItem('conduit-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}</script>
  <style>${STYLES}</style>
</head>
<body>
${body}
<script id="conduit-config" type="application/json">${config}</script>
<script src="/app.js"></script>
</body>
</html>`;
}

export function renderAppJs(): string {
  return CLIENT_JS;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] ?? char));
}

const CLIENT_JS = `
// Conduit Control client. Served as /app.js by src/app/control-panel.ts.
// Authoring rule: this source is embedded in a TypeScript template literal, so it
// avoids backticks, dollar-brace sequences and backslashes. Use NL / FENCE below.
const NL = String.fromCharCode(10);
const FENCE = String.fromCharCode(96).repeat(3);
const VIEWS = ['overview', 'approvals', 'sessions', 'runs', 'diagnostics'];
const VIEW_TEXT = {
  overview: ['Overview', 'Local services, pending decisions, and what Conduit is currently allowed to do.'],
  approvals: ['Approvals', 'Nothing with local effects runs until you decide. Check the source, the declared permissions and every action, then approve once or deny.'],
  sessions: ['Sessions', 'A paired session carries a one-shot nonce and a permission profile scoped to the roots you choose.'],
  runs: ['Runs', 'Every executed request leaves a local run record with its policy decisions and results.'],
  diagnostics: ['Report Bug', 'A redacted diagnostic bundle you can read in full before sharing it.']
};
const PROFILE_HINTS = {
  'read-only': '<b>read-only</b>: reads, listings and git inspection run automatically. Writes, patches and shell are denied.',
  'edit-with-confirmation': '<b>edit-with-confirmation</b>: reads run automatically. Every file write or patch waits for your approval. Shell is denied.',
  'shell-manual': '<b>shell-manual</b>: reads run automatically. Writes, patches and every shell command wait for your approval.'
};
const config = readConfig();
const DEMO = new URLSearchParams(location.search).has('demo');
const state = { status: null, bridge: null, sessions: [], approvals: [], runs: [], view: 'overview' };
const $ = (id) => document.getElementById(id);
let demoStore = null;
let toastTimer = null;

function readConfig() {
  try {
    return JSON.parse(document.getElementById('conduit-config').textContent || '{}');
  } catch {
    return {};
  }
}

async function api(path, options = {}) {
  if (DEMO) return demoApi(path, options);
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setStatus(text, kind) {
  const toast = $('appStatus');
  toast.textContent = text || '';
  toast.classList.toggle('error', kind === 'error');
  toast.classList.toggle('show', Boolean(text));
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => toast.classList.remove('show'), 5200);
}

let lastSignature = '';

async function refresh(onlyIfChanged) {
  const [status, bridge, sessions, approvals, runs] = await Promise.all([
    api('/api/status'),
    fetchBridgeHealth(),
    api('/api/sessions'),
    api('/api/approvals'),
    api('/api/runs')
  ]);
  // Background polls skip re-rendering when nothing changed, so open details
  // and scroll positions are not disturbed while the user is reading.
  const signature = JSON.stringify([status, bridge, sessions, approvals, runs]);
  if (onlyIfChanged && signature === lastSignature) return;
  lastSignature = signature;
  state.status = status;
  state.bridge = bridge;
  state.sessions = sessions.sessions;
  state.approvals = approvals.approvals;
  state.runs = runs.runs;
  render();
}

function pendingApprovals() {
  return state.approvals.filter((approval) => approval.status === 'pending');
}

function activeSessions() {
  return state.sessions.filter((session) => session.state === 'active' || session.state === 'awaiting_result_paste');
}

function render() {
  const pending = pendingApprovals();
  $('pendingCount').textContent = pending.length;
  $('pendingStat').classList.toggle('attention', pending.length > 0);
  $('approvalCount').textContent = pending.length;
  $('approvalCount').hidden = pending.length === 0;
  $('sessionCount').textContent = activeSessions().length;
  $('runCount').textContent = state.runs.length;
  $('mode').textContent = state.status?.mode || 'Compliance';
  $('modeStat').textContent = state.status?.mode || 'Compliance';
  $('statusJson').textContent = JSON.stringify(state.status, null, 2);
  $('bridgeJson').textContent = JSON.stringify(state.bridge, null, 2);
  $('bridgeAvailability').textContent = bridgeAvailabilityText(state.bridge);
  $('retryOutbound').disabled = !bridgeCanRetry(state.bridge);
  renderServices();
  renderQueuePreview(pending);
  renderSessions();
  renderApprovals();
  renderRuns();
}

function renderServices() {
  const bridge = state.bridge || {};
  const bridgeOnline = bridge.status && bridge.status !== 'offline';
  const tab = bridge.tabAvailability;
  const rows = [
    ['ok', 'Control panel', location.host + (DEMO ? ' (demo data)' : '')],
    [bridgeOnline ? (tab && tab.status !== 'ready' ? 'warn' : 'ok') : 'off', 'Extension bridge', bridgeOnline ? '127.0.0.1:3333' + (tab ? ' / ChatGPT tab ' + tab.status : '') : 'offline. Optional; clipboard flows work without it.'],
    ['ok', 'Clipboard watcher', state.status?.exactEnvelopeParsing === false ? 'embedded-block parsing enabled' : 'exact envelopes only, embedded blocks ignored'],
    ['ok', 'State', state.status?.stateRoot || '~/.conduit']
  ];
  $('services').innerHTML = rows.map((row) => '<div class="service"><span class="dot ' + (row[0] === 'ok' ? '' : row[0]) + '"></span><div><strong>' + escapeHtml(row[1]) + '</strong><div class="mono">' + escapeHtml(row[2]) + '</div></div></div>').join('');
}

function renderQueuePreview(pending) {
  if (pending.length === 0) {
    $('queuePreview').innerHTML = '<div class="empty"><strong>Nothing is waiting on you.</strong><span>New review requests and confirmation prompts will appear here.</span></div>';
    return;
  }
  $('queuePreview').innerHTML = pending.slice(0, 4).map((approval) => '<div class="queue-item">' +
    '<span class="badge ' + (isReview(approval) ? 'warn' : 'danger') + '">' + (isReview(approval) ? 'Review' : 'Confirm') + '</span>' +
    '<div class="grow"><strong>' + escapeHtml(approvalTitle(approval)) + '</strong><span class="subtle">' + escapeHtml(approvalSummaryLine(approval)) + '</span></div>' +
    '<button class="btn small" data-view="approvals" type="button">Review</button>' +
  '</div>').join('');
}

function renderSessions() {
  if (state.sessions.length === 0) {
    $('sessionsTable').innerHTML = '<div class="empty"><strong>No sessions yet.</strong><span>Pair one above, or use Copy Agent Handshake to start an agent loop.</span></div>';
    return;
  }
  $('sessionsTable').innerHTML = '<div class="table-wrap"><table class="stack"><thead><tr><th>Session</th><th>Transport</th><th>Profile</th><th>Allowed roots</th><th>Nonce</th><th>State</th><th></th></tr></thead><tbody>' +
    state.sessions.map((session) => '<tr>' +
      '<td class="first"><strong>' + escapeHtml(session.label) + '</strong><br><span class="mono">' + escapeHtml(session.sessionId) + '</span></td>' +
      '<td data-label="Transport">' + escapeHtml(session.transport || 'clipboard') + '</td>' +
      '<td data-label="Profile"><span class="badge">' + escapeHtml(session.permissionProfile) + '</span></td>' +
      '<td data-label="Roots"><span class="mono">' + escapeHtml((session.allowedRoots || []).join(', ')) + '</span></td>' +
      '<td data-label="Nonce"><code class="nonce" title="' + escapeHtml(session.currentNonce) + '">' + escapeHtml(session.currentNonce) + '</code></td>' +
      '<td data-label="State">' + sessionStateBadge(session.state) + '</td>' +
      '<td class="cell-actions">' + (session.state === 'revoked' || session.state === 'expired' ? '' : '<button class="btn small danger" data-revoke="' + encodeURIComponent(session.sessionId) + '" type="button">Revoke</button>') + '</td>' +
    '</tr>').join('') + '</tbody></table></div>';
}

function sessionStateBadge(value) {
  const kind = value === 'active' ? 'ok' : value === 'revoked' || value === 'expired' ? 'danger' : 'warn';
  return '<span class="badge ' + kind + '">' + escapeHtml(value) + '</span>';
}

function isReview(approval) {
  return approval.action?.tool === 'conduit.review';
}

function approvalTitle(approval) {
  if (isReview(approval)) {
    return approval.action?.args?.title || 'Untrusted Conduit request';
  }
  return (approval.action?.tool || 'action') + ' needs confirmation';
}

function approvalSummaryLine(approval) {
  if (isReview(approval)) {
    const actions = Array.isArray(approval.action?.args?.actions) ? approval.action.args.actions : [];
    return sourceLabel(approval.action?.args?.source) + ' / ' + actions.length + ' action' + (actions.length === 1 ? '' : 's');
  }
  return approval.action?.reason || approval.policyReason || '';
}

function renderApprovals() {
  const visible = state.approvals.filter((approval) => approval.status === 'pending' || approval.executionStatus);
  const pendingFirst = visible.slice().sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
  if (pendingFirst.length === 0) {
    $('approvalsTable').innerHTML = '<div class="panel"><div class="empty"><strong>No active approvals.</strong><span>When a request needs your consent it appears here with its source, permissions and actions.</span></div></div>';
  } else {
    $('approvalsTable').innerHTML = pendingFirst.map(approvalCardHtml).join('');
  }
  const decided = state.approvals.filter((approval) => approval.status !== 'pending' && !approval.executionStatus).slice(0, 6);
  $('historyPanel').hidden = decided.length === 0;
  $('historyList').innerHTML = decided.map((approval) => '<div class="history-row">' +
    '<div><strong>' + escapeHtml(approvalTitle(approval)) + '</strong><span class="subtle">' + escapeHtml((approval.decidedBy ? 'via ' + approval.decidedBy : '') + (approval.decisionReason ? ' / ' + approval.decisionReason : '')) + '</span></div>' +
    '<span class="subtle when">' + escapeHtml(ago(approval.decidedAt || approval.updatedAt)) + '</span>' +
    decisionBadge(approval.status) +
  '</div>').join('');
}

function decisionBadge(status) {
  const kind = status === 'approved' ? 'ok' : status === 'denied' ? 'danger' : '';
  return '<span class="badge ' + kind + '">' + escapeHtml(status) + '</span>';
}

function approvalCardHtml(approval) {
  const pending = approval.status === 'pending' && !approval.executionStatus;
  const cls = pending ? '' : approval.executionStatus === 'ran' ? ' ran' : ' decided';
  return '<article class="consent' + cls + '">' +
    '<header class="consent-head">' +
      '<div class="consent-tags">' + approvalTagsHtml(approval) + '</div>' +
      '<h3>' + approvalRequestHtml(approval) + '</h3>' +
      (approval.action?.reason ? '<p>' + escapeHtml(approval.action.reason) + '</p>' : '') +
      '<div class="consent-meta mono">' + escapeHtml(approval.approvalId) + ' / ' + escapeHtml(ago(approval.createdAt)) + (approval.projectRoot ? ' / root ' + escapeHtml(approval.projectRoot) : '') + '</div>' +
    '</header>' +
    '<div class="consent-grid">' + approvalReviewHtml(approval) + approvalDetailsHtml(approval) + '</div>' +
    (isReview(approval) ? '<p class="policy-note">' + SHIELD_ICON + '<span>Approve once runs under read-only local policy. It does not create a trusted session or widen future policy.</span></p>' : '<p class="policy-note">' + SHIELD_ICON + '<span>' + escapeHtml(approval.policyReason || 'This action requires confirmation under the session profile.') + ' Approving allows this one action only.</span></p>') +
    '<details><summary>Raw request</summary><pre>' + escapeHtml(JSON.stringify(approval.action?.args || {}, null, 2)) + '</pre></details>' +
    '<footer class="consent-foot"><div>' + approvalStateHtml(approval) + '</div><div class="decide">' + approvalActionsHtml(approval) + '</div></footer>' +
  '</article>';
}

function approvalTagsHtml(approval) {
  const tags = [];
  if (isReview(approval)) tags.push('<span class="badge warn">Untrusted source</span>');
  else tags.push('<span class="badge danger">Confirmation required</span>');
  const risk = approval.action?.risk;
  if (risk) tags.push('<span class="badge ' + (risk === 'high' ? 'danger' : risk === 'medium' ? 'warn' : '') + '">' + escapeHtml(risk) + ' risk</span>');
  return tags.join('');
}

function approvalRequestHtml(approval) {
  if (isReview(approval)) {
    return escapeHtml(approval.action?.args?.title || 'Untrusted Conduit request');
  }
  return '<code>' + escapeHtml(approval.action?.tool || '') + '</code> needs your confirmation';
}

function approvalButtonLabel(approval) {
  return isReview(approval) ? 'Approve once' : 'Approve';
}

function approvalStateHtml(approval) {
  const label = approval.executionStatus
    ? approval.executionStatus
    : approval.status === 'pending'
      ? 'pending review'
      : approval.status;
  const detail = approval.executionRunId
    ? 'run ' + approval.executionRunId
    : approval.executionError || approval.decisionReason || '';
  const kind = label === 'ran' || label === 'approved' ? 'ok' : label === 'failed' || label === 'denied' ? 'danger' : 'warn';
  return '<span class="badge ' + kind + '">' + escapeHtml(label) + '</span>' + (detail ? ' <span class="subtle">' + escapeHtml(detail) + '</span>' : '');
}

function approvalReviewHtml(approval) {
  if (!isReview(approval)) {
    return '<section><h4>Why it stopped</h4><p>' + escapeHtml(approval.action?.reason || '(none provided)') + '</p><p class="subtle">' + escapeHtml(approval.policyReason || '') + '</p></section>' +
      '<section><h4>Session</h4><p class="mono">' + escapeHtml(approval.sessionId || 'terminal run') + '</p>' + (approval.runId ? '<p class="subtle">run ' + escapeHtml(approval.runId) + '</p>' : '') + '</section>';
  }
  const args = approval.action?.args || {};
  const sessionText = args.sessionId
    ? '<p class="subtle">Session claim: <span class="mono">' + escapeHtml(args.sessionId) + '</span></p>'
    : '<p class="subtle">No live trusted session.</p>';
  return '<section><h4>Where it came from</h4><p><strong>' + escapeHtml(sourceLabel(args.source)) + '</strong></p>' + sessionText + '</section>' +
    '<section><h4>What it may touch</h4><div class="chips">' + permissionChips(args.permissions) + '</div><p class="subtle" style="margin-top:8px">' + escapeHtml(permissionSummary(args.permissions)) + '</p></section>';
}

function approvalDetailsHtml(approval) {
  if (!isReview(approval)) {
    const args = approval.action?.args || {};
    const preview = args.command || args.patch || args.content || JSON.stringify(args, null, 2);
    return '<section><h4>Exact change</h4>' + (args.path ? '<p class="mono" style="margin-bottom:8px">' + escapeHtml(args.path) + '</p>' : '') + '<pre>' + escapeHtml(String(preview).slice(0, 1200)) + '</pre></section>';
  }
  const args = approval.action?.args || {};
  const actions = Array.isArray(args.actions) ? args.actions : [];
  const actionList = actions.length > 0
    ? actions.map((action) => '<li><code>' + escapeHtml(action.tool || '') + '</code><span>' + escapeHtml(action.id || '(no id)') + (action.reason ? ' / ' + escapeHtml(action.reason) : '') + '</span></li>').join('')
    : '<li>No actions declared.</li>';
  const capabilityText = Array.isArray(args.requestedCapabilities) && args.requestedCapabilities.length > 0
    ? '<p class="subtle" style="margin-top:8px">Capabilities: ' + escapeHtml(args.requestedCapabilities.join(', ')) + '</p>'
    : '';
  return '<section><h4>What it will do</h4><ol class="action-list">' + actionList + '</ol>' + capabilityText + '</section>';
}

function sourceLabel(source) {
  if (!source || typeof source !== 'object') return 'Source: unknown';
  const kind = source.kind || 'unknown';
  const trust = source.trust || 'untrusted';
  return 'Source: ' + kind + ' / ' + trust + (source.domain ? ' (' + source.domain + ')' : '');
}

function permissionChips(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) return '<span class="chip">none declared</span>';
  return permissions.map((permission) => '<span class="chip">' + escapeHtml(permissionText(permission)) + '</span>').join('');
}

function permissionText(permission) {
  if (!permission || typeof permission !== 'object') return 'unknown';
  return [permission.kind, permission.scope, permission.access].filter(Boolean).join(':') || 'unknown';
}

function permissionSummary(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) return 'Declared permissions: none';
  return 'Declared permissions: ' + permissions.map(permissionText).join(', ');
}

function approvalActionsHtml(approval) {
  if (approval.executionStatus === 'running') {
    return '<button class="btn" disabled type="button">Running...</button>';
  }
  if (approval.executionRunId) {
    return '<button class="btn" data-result="' + encodeURIComponent(approval.executionRunId) + '" type="button">View result</button>';
  }
  if (approval.status !== 'pending') {
    return '';
  }
  return '<button class="btn danger" data-deny="' + encodeURIComponent(approval.approvalId) + '" type="button">Deny</button>' +
    '<button class="btn primary" data-approve="' + encodeURIComponent(approval.approvalId) + '" type="button">' + approvalButtonLabel(approval) + '</button>';
}

function renderRuns() {
  if (state.runs.length === 0) {
    $('runsTable').innerHTML = '<div class="empty"><strong>No runs yet.</strong><span>Approved and trusted requests leave a run record here.</span></div>';
    return;
  }
  $('runsTable').innerHTML = '<div class="table-wrap"><table class="stack"><thead><tr><th>Run</th><th>Status</th><th>Project</th><th>Started</th><th></th></tr></thead><tbody>' +
    state.runs.map((run) => '<tr>' +
      '<td class="first"><strong class="mono">' + escapeHtml(run.runId) + '</strong><br><span class="subtle">' + escapeHtml(run.mode || '') + (run.summary ? ' / ' + escapeHtml(run.summary) : '') + '</span></td>' +
      '<td data-label="Status">' + runStatusBadge(run.status) + '</td>' +
      '<td data-label="Project"><span class="mono">' + escapeHtml(run.projectRoot || '') + '</span></td>' +
      '<td data-label="Started">' + escapeHtml(run.startedAt ? ago(run.startedAt) : '') + '</td>' +
      '<td class="cell-actions"><button class="btn small" data-result="' + encodeURIComponent(run.runId) + '" type="button">View</button></td>' +
    '</tr>').join('') + '</tbody></table></div>';
}

function runStatusBadge(status) {
  const value = status || 'unknown';
  const kind = value === 'complete' || value === 'ok' || value === 'request' ? 'ok' : value === 'failed' || value === 'error' ? 'danger' : '';
  return '<span class="badge ' + kind + '">' + escapeHtml(value) + '</span>';
}

function ago(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + ' h ago';
  return new Date(iso).toLocaleDateString();
}

function setView(view) {
  state.view = view;
  for (const id of VIEWS) {
    $(id + 'View').classList.toggle('hidden', id !== view);
    document.querySelector('.nav [data-view="' + id + '"]').classList.toggle('active', id === view);
  }
  $('title').textContent = VIEW_TEXT[view][0];
  $('subtitle').textContent = VIEW_TEXT[view][1];
  if (location.hash !== '#' + view) {
    history.replaceState(null, '', location.pathname + location.search + '#' + view);
  }
}

function initialView() {
  const hash = location.hash.replace(/^#/, '');
  return VIEWS.includes(hash) ? hash : 'overview';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function guarded(task) {
  try {
    await task();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    document.querySelectorAll('[data-approve], [data-deny]').forEach((button) => { button.disabled = false; });
  }
}

document.addEventListener('click', (event) => guarded(async () => {
  const target = event.target.closest('button, a');
  if (!target) return;
  const data = target.dataset || {};

  if (data.view) setView(data.view);

  if (data.copy) {
    const copied = await copyText($(data.copy).textContent);
    setStatus(copied ? 'Copied.' : 'Copy failed; select the text and copy it manually.', copied ? '' : 'error');
  }

  if (data.revoke) {
    await api('/api/sessions/' + data.revoke + '/revoke', { method: 'POST' });
    setStatus('Session revoked. Its nonce no longer works.');
    await refresh();
  }

  if (data.approve) {
    target.disabled = true;
    const result = await api('/api/approvals/' + data.approve + '/approve', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Approved from Conduit Control.' })
    });
    if (result.execution?.runId && result.copiedToClipboard) {
      setStatus('Approved, executed run ' + result.execution.runId + ', and copied results to clipboard.');
    } else if (result.execution?.runId) {
      setStatus('Approved and executed run ' + result.execution.runId + '.');
    } else {
      setStatus('Action approved.');
    }
    await refresh();
  }

  if (data.deny) {
    target.disabled = true;
    await api('/api/approvals/' + data.deny + '/deny', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Denied from Conduit Control.' })
    });
    setStatus('Action denied. Nothing ran.');
    await refresh();
  }

  if (data.result) {
    const result = await api('/api/runs/' + data.result + '/result');
    if (state.view !== 'runs') setView('runs');
    $('resultTitle').textContent = 'Result / ' + decodeURIComponent(data.result);
    $('runResult').textContent = result.result || '(no result text)';
    $('resultPanel').classList.remove('hidden');
    $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}));

$('refresh').addEventListener('click', () => guarded(async () => {
  await refresh();
  setStatus('Refreshed.');
}));
$('reportBug').addEventListener('click', () => guarded(async () => {
  setView('diagnostics');
  await loadDiagnostics();
}));
$('copyDiagnostics').addEventListener('click', () => guarded(async () => {
  await loadDiagnostics();
  const copied = await copyText($('diagnosticsJson').textContent);
  setStatus(copied ? 'Redacted diagnostics copied.' : 'Copy failed; select the JSON and copy it manually.', copied ? '' : 'error');
}));
$('checkClipboard').addEventListener('click', () => guarded(async () => {
  setStatus('Checking clipboard...');
  const result = await api('/api/clipboard/check', { method: 'POST' });
  const detail = result.error || result.reason || result.output?.reason || '';
  setStatus('Clipboard check: ' + result.status + (detail ? ' / ' + detail : ''), result.status === 'error' ? 'error' : '');
  await refresh();
}));

$('retryOutbound').addEventListener('click', () => guarded(async () => {
  const transportId = selectRetryTransportId(state.bridge);
  await fetchBridgeRetry(transportId);
  setStatus('Queued outbound retry.');
  await refresh();
}));

$('copyHandshake').addEventListener('click', () => guarded(async () => {
  setStatus('Creating agent handshake...');
  const result = await api('/api/agent-handshake', {
    method: 'POST',
    body: JSON.stringify({
      label: 'Chat agent loop',
      root: config.cwd || '',
      profile: 'read-only',
      transport: 'extension'
    })
  });
  let copied = result.copied;
  if (!copied) copied = await copyText(result.handshake);
  $('handshakeText').textContent = result.handshake;
  $('handshakeNote').textContent = copied
    ? 'Copied. Paste it into the chat that should drive session ' + result.session.sessionId + '.'
    : 'Clipboard unavailable here; copy it from below. Session ' + result.session.sessionId + '.';
  $('handshakePanel').classList.remove('hidden');
  setView('sessions');
  setStatus(copied ? 'Agent handshake copied to clipboard.' : 'Agent handshake created.');
  await refresh();
}));

$('profileSelect').addEventListener('change', updateProfileHint);

$('createSession').addEventListener('submit', (event) => guarded(async () => {
  event.preventDefault();
  const form = new FormData(event.target);
  const data = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      label: form.get('label'),
      root: form.get('root'),
      profile: form.get('profile')
    })
  });
  $('sessionStatus').textContent = 'Created ' + data.session.sessionId + '. Copy only the fenced block below into the chat.';
  $('starterEnvelope').textContent = FENCE + 'conduit' + NL + JSON.stringify(data.starterEnvelope, null, 2) + NL + FENCE;
  $('starterPanel').classList.remove('hidden');
  await refresh();
}));

$('themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('conduit-theme', next); } catch {}
});

function updateProfileHint() {
  $('profileHint').innerHTML = PROFILE_HINTS[$('profileSelect').value] || '';
}

async function loadDiagnostics() {
  const data = await api('/api/diagnostics');
  $('diagnosticsJson').textContent = JSON.stringify(data.bundle, null, 2);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

async function fetchBridgeHealth() {
  if (DEMO) return demoState().bridge;
  try {
    const response = await fetch('http://127.0.0.1:3333/health');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch (error) {
    return {
      status: 'offline',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchBridgeRetry(transportId) {
  if (DEMO) return { status: 'queued', transportId, demo: true };
  const response = await fetch('http://127.0.0.1:3333/api/conduit-retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transportId ? { transportId } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Retry failed');
  return data;
}

function bridgeCanRetry(bridge) {
  return Boolean(bridge?.attentionOutboundIds?.length || bridge?.retryingOutboundIds?.length || bridge?.pendingSendResultIds?.length);
}

function bridgeAvailabilityText(bridge) {
  if (bridge?.status === 'offline') return 'Bridge offline: ' + (bridge.error || 'local listener is not reachable');
  const availability = bridge?.tabAvailability;
  if (!availability) return 'ChatGPT tab availability unknown.';
  return 'ChatGPT tab ' + availability.status + ': ' + availability.reason;
}

function selectRetryTransportId(bridge) {
  return bridge?.attentionOutboundIds?.[0]
    || bridge?.retryingOutboundIds?.[0]
    || bridge?.pendingSendResultIds?.[0];
}

// ---------------------------------------------------------------------------
// Demo data mode (?demo=1). Everything below is in-memory sample data for
// visitors and screenshots. It never calls the local API, never touches the
// clipboard and never executes anything. Real mode never reaches this code.
// ---------------------------------------------------------------------------

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

function demoState() {
  if (demoStore) return demoStore;
  const root = '~/projects/field-notes';
  demoStore = {
    counter: 0,
    status: {
      status: 'ok',
      mode: 'Compliance',
      stateRoot: '~/.conduit (demo)',
      exactEnvelopeParsing: true,
      embeddedBlockParsing: false,
      clipboardWatcher: 'available',
      demo: true,
      capabilities: { agentHandshake: true, clipboardCheck: true, conduitUrlOpen: true, approvals: true, sessions: true, runs: true }
    },
    bridge: {
      status: 'ok',
      demo: true,
      tabStatusCount: 1,
      tabAvailability: { status: 'ready', reason: 'content script heartbeat 12s ago' },
      outboundQueued: 0,
      pendingPolls: 1,
      pendingSendResults: 0,
      attentionOutboundIds: [],
      retryingOutboundIds: [],
      pendingSendResultIds: []
    },
    sessions: [
      { sessionId: 'sess_7k2m9q', label: 'ChatGPT / field-notes refactor', createdAt: minutesAgo(52), state: 'active', transport: 'extension', permissionProfile: 'edit-with-confirmation', allowedRoots: [root], currentNonce: 'call_4f9a1c7e2b', usedNonces: [] },
      { sessionId: 'sess_3x8p1d', label: 'Clipboard session', createdAt: minutesAgo(190), state: 'active', transport: 'clipboard', permissionProfile: 'read-only', allowedRoots: [root], currentNonce: 'call_9b03de5a61', usedNonces: [] },
      { sessionId: 'sess_0r5t6w', label: 'Release checklist', createdAt: minutesAgo(1440), state: 'revoked', transport: 'clipboard', permissionProfile: 'shell-manual', allowedRoots: ['~/projects/site'], currentNonce: 'call_revoked', usedNonces: [] }
    ],
    approvals: [
      {
        approvalId: 'approval_demo_review',
        status: 'pending',
        createdAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
        projectRoot: root,
        policyReason: 'Exact envelope without a live trusted session.',
        action: {
          id: 'review_untrusted_request',
          tool: 'conduit.review',
          risk: 'high',
          reason: 'Copied from a chat reply: summarize the notes folder and show what changed since the last commit.',
          args: {
            title: 'Summarize notes and recent changes',
            source: { kind: 'clipboard', trust: 'untrusted' },
            permissions: [{ kind: 'filesystem', scope: 'project', access: 'read' }, { kind: 'git', scope: 'project', access: 'read' }],
            requestedCapabilities: [],
            actions: [
              { id: 'list_notes', tool: 'file.list', args: { path: 'notes' }, reason: 'See what notes exist.' },
              { id: 'read_index', tool: 'file.read', args: { path: 'notes/index.md' }, reason: 'Read the table of contents.' },
              { id: 'diff_head', tool: 'git.diff', args: {}, reason: 'Compare against the last commit.' }
            ],
            sessionId: null,
            noncePresent: false
          }
        }
      },
      {
        approvalId: 'approval_demo_patch',
        status: 'pending',
        createdAt: minutesAgo(6),
        updatedAt: minutesAgo(6),
        projectRoot: root,
        sessionId: 'sess_7k2m9q',
        runId: 'run_demo_0412',
        policyReason: 'Tool requires confirmation: file.patch',
        action: {
          id: 'fix_heading',
          tool: 'file.patch',
          risk: 'medium',
          reason: 'Rename the Inbox heading to Triage, as discussed.',
          args: {
            path: 'notes/index.md',
            patch: '--- a/notes/index.md' + NL + '+++ b/notes/index.md' + NL + '@@ -1,4 +1,4 @@' + NL + ' # Field notes' + NL + ' ' + NL + '-## Inbox' + NL + '+## Triage' + NL + ' - [ ] Sort the June captures'
          }
        }
      },
      {
        approvalId: 'approval_demo_ran',
        status: 'approved',
        createdAt: minutesAgo(41),
        updatedAt: minutesAgo(40),
        decidedAt: minutesAgo(40),
        decidedBy: 'control-app',
        decisionReason: 'Approved from Conduit Control.',
        executionStatus: 'ran',
        executionRunId: 'run_demo_0398',
        projectRoot: root,
        action: {
          id: 'review_untrusted_request',
          tool: 'conduit.review',
          risk: 'high',
          reason: 'List the project root.',
          args: {
            title: 'List the project root',
            source: { kind: 'conduit-link', trust: 'untrusted', domain: 'docs.example.com' },
            permissions: [{ kind: 'filesystem', scope: 'project', access: 'read' }],
            actions: [{ id: 'list_root', tool: 'file.list', args: { path: '.' } }],
            sessionId: null,
            noncePresent: false
          }
        }
      },
      {
        approvalId: 'approval_demo_denied',
        status: 'denied',
        createdAt: minutesAgo(130),
        updatedAt: minutesAgo(128),
        decidedAt: minutesAgo(128),
        decidedBy: 'terminal',
        decisionReason: 'Not running installs from chat.',
        projectRoot: root,
        policyReason: 'Tool requires confirmation: shell.run',
        action: { id: 'install_deps', tool: 'shell.run', risk: 'high', reason: 'Install dependencies.', args: { command: 'curl -fsSL https://example.invalid/install.sh | sh' } }
      }
    ],
    runs: [
      { runId: 'run_demo_0412', mode: 'agent-loop', projectRoot: root, startedAt: minutesAgo(7), status: 'awaiting approval', summary: 'Heading rename', hasResult: false },
      { runId: 'run_demo_0398', mode: 'approved-review', approvalId: 'approval_demo_ran', projectRoot: root, startedAt: minutesAgo(40), status: 'complete', summary: 'Listed 14 entries', hasResult: true },
      { runId: 'run_demo_0377', mode: 'clipboard', projectRoot: root, startedAt: minutesAgo(95), status: 'complete', summary: 'Read README.md', hasResult: true },
      { runId: 'run_demo_0350', mode: 'agent-loop', projectRoot: '~/projects/site', startedAt: minutesAgo(1500), status: 'failed', summary: 'Patch did not apply cleanly', hasResult: true }
    ],
    results: {
      run_demo_0398: FENCE + 'CONDUIT_RESULTS_JSON' + NL + JSON.stringify({ schema: 'conduit.results.v1', results: [{ id: 'list_root', ok: true, entries: ['README.md', 'notes/', 'package.json', 'scripts/'] }] }, null, 2) + NL + FENCE,
      run_demo_0377: FENCE + 'CONDUIT_RESULTS_JSON' + NL + JSON.stringify({ schema: 'conduit.results.v1', results: [{ id: 'read_readme', ok: true, bytes: 1834 }] }, null, 2) + NL + FENCE,
      run_demo_0350: 'file.patch failed: hunk 1 did not match notes/archive.md'
    }
  };
  return demoStore;
}

async function demoApi(path, options = {}) {
  const store = demoState();
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : {};
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (path === '/api/status') return store.status;
  if (path === '/api/sessions' && method === 'GET') return { sessions: store.sessions };
  if (path === '/api/approvals') return { approvals: store.approvals };
  if (path === '/api/runs') return { runs: store.runs };
  if (path === '/api/diagnostics') {
    return { bundle: { schema: 'conduit.diagnostic-bundle.v1', demo: true, app: { version: '0.0.1' }, services: { controlPanel: { status: 'ok' } }, state: { redaction: { excludesClipboardContents: true, excludesRequestPayloads: true, excludesSessionNonces: true, excludesApiKeys: true } }, sessions: store.sessions.map((s) => ({ sessionId: s.sessionId, state: s.state, hasCurrentNonce: true })) } };
  }
  if (path === '/api/clipboard/check') return { status: 'no-envelope', reason: 'demo mode does not read your clipboard' };
  if (path === '/api/sessions' && method === 'POST') {
    const session = demoSession(body.label || 'App session', body.profile || 'read-only', 'clipboard', body.root);
    return { session, starterEnvelope: { schema: 'conduit.request.v1', source: { kind: 'clipboard', trust: 'untrusted' }, permissions: [{ kind: 'filesystem', scope: 'project', access: 'read' }], sessionId: session.sessionId, nonce: session.currentNonce, list: '.', reason: 'List the project root.', risk: 'low' } };
  }
  if (path === '/api/agent-handshake') {
    const session = demoSession(body.label || 'Agent handshake', 'read-only', 'extension', body.root);
    return { session, copied: false, handshake: 'Conduit agent-loop handshake (demo)' + NL + NL + JSON.stringify({ schema: 'conduit.handshake.v1', session: { sessionId: session.sessionId, nonce: session.currentNonce, permissionProfile: 'read-only' } }, null, 2) };
  }
  const revoke = path.match(/^[/]api[/]sessions[/]([^/]+)[/]revoke$/);
  if (revoke) {
    const session = store.sessions.find((s) => s.sessionId === decodeURIComponent(revoke[1]));
    if (session) session.state = 'revoked';
    return { session };
  }
  const decision = path.match(/^[/]api[/]approvals[/]([^/]+)[/](approve|deny)$/);
  if (decision) {
    const approval = store.approvals.find((a) => a.approvalId === decodeURIComponent(decision[1]));
    if (!approval) throw new Error('Unknown approval');
    approval.status = decision[2] === 'approve' ? 'approved' : 'denied';
    approval.decidedAt = new Date().toISOString();
    approval.decidedBy = 'control-app (demo)';
    approval.decisionReason = body.reason;
    if (approval.status === 'approved' && approval.action.tool === 'conduit.review') {
      const runId = 'run_demo_' + String(500 + (store.counter += 1));
      approval.executionStatus = 'ran';
      approval.executionRunId = runId;
      store.runs.unshift({ runId, mode: 'approved-review', projectRoot: approval.projectRoot, startedAt: approval.decidedAt, status: 'complete', summary: 'Simulated in demo mode', hasResult: true });
      store.results[runId] = 'Demo mode: nothing was executed. A real approval runs these actions once under read-only policy and returns CONDUIT_RESULTS_JSON.';
      return { approval, execution: { runId }, copiedToClipboard: false };
    }
    return { approval };
  }
  const result = path.match(/^[/]api[/]runs[/]([^/]+)[/]result$/);
  if (result) {
    const runId = decodeURIComponent(result[1]);
    return { runId, result: store.results[runId] || '(no result text in demo data)' };
  }
  throw new Error('Demo mode does not implement ' + path);
}

function demoSession(label, profile, transport, root) {
  const store = demoState();
  store.counter += 1;
  const session = { sessionId: 'sess_demo' + store.counter, label, createdAt: new Date().toISOString(), state: 'active', transport, permissionProfile: profile, allowedRoots: [root || '~/projects/field-notes'], currentNonce: 'call_demo' + store.counter + 'a7f3', usedNonces: [] };
  store.sessions.unshift(session);
  return session;
}

const SHIELD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>';

if (DEMO) {
  document.body.classList.add('demo');
  $('demoBanner').hidden = false;
  $('demoLink').textContent = 'Exit demo data';
  $('demoLink').href = './';
}
$('rootInput').value = DEMO ? '~/projects/field-notes' : (config.cwd || '');
updateProfileHint();
setView(initialView());
refresh().catch((error) => setStatus(error.message, 'error'));
window.addEventListener('hashchange', () => {
  setView(initialView());
  refresh().catch((error) => setStatus(error.message, 'error'));
});
// New approvals can arrive from the daemon or a terminal run at any time.
setInterval(() => {
  if (!document.hidden) refresh(true).catch(() => {});
}, 4000);
`;
