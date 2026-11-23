/**
 * Plugin-owned CSS for the DevLead conversation surfaces: the composer-toolbar
 * toggle, the enabled-only status strip, and the sidebar marks.
 *
 * The package deliberately ships no CSS Modules build chain: `apply()` injects
 * this string once into `document.head` as a `<style data-plugin-css="devlead">`
 * tag. Class names are plain, globally unique hyphenated names. Colors lean on
 * the harness theme tokens (`--dsw-*` / `--dsh-*`) with neutral CSS fallbacks so
 * the strip follows light/dark themes, and degrades to readable browser colors
 * if a token is ever missing.
 */

/** Attribute marking this plugin's injected style tag. */
const STYLE_ATTRIBUTE = 'data-plugin-css'

/** Value of {@link STYLE_ATTRIBUTE} owned by this plugin. */
const STYLE_KEY = 'devlead'

/** Global stylesheet of the DevLead conversation surfaces. */
export const styles = `
/* Composer-tool row control: the users glyph plus a visible DevLead label. It
   keeps the 28px control height of the toolbar and sizes horizontally from its
   content, rather than occupying a fixed square glyph seat. The transparent
   1px border is part of the base box (with 1px less padding), so enabling the
   accent border changes colour only, never the control's size or the toolbar
   layout. */
.devlead-toggle {
  flex: none;
  width: auto;
  height: 28px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  gap: 6px;
  color: var(--dsw-alias-label-secondary, GrayText);
}

.devlead-toggle-label {
  flex: none;
  font-weight: 500;
  white-space: nowrap;
}

@media (hover: hover) {
  .devlead-toggle:hover:not(:disabled):not([data-devlead-failed="true"]) {
    color: var(--dsw-alias-label-primary, CanvasText);
  }
}

/* While the mode is on the same button stays in place and reads at full label
   color, with the business accent as a real border plus a very light halo.
   The halo is a box-shadow so it cannot add layout width; the border was
   already reserved (transparent) in the base rule. The failed rule below has
   the same specificity and wins the colour, so an error never leaves a blue
   accent behind. */
.devlead-toggle[data-devlead-enabled="true"] {
  color: var(--dsw-alias-label-primary, CanvasText);
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.12));
}

.devlead-toggle[data-devlead-failed="true"] {
  color: var(--dsw-alias-label-error, #c0392b);
  border-color: var(--dsw-alias-label-error, #c0392b);
  box-shadow: none;
}

/* The shell marks an active toolbar control with a subtle fill; the mode is a
   pressed toggle, not only a colour change, so mirror that affordance. */
.devlead-toggle[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

/* On a narrow viewport the visible label and the stale-watch warning would
   squeeze the composer toolbar and the status notice. The toggle keeps its
   accessible name and icon; the bar keeps the watched/running counts. */
@media (max-width: 480px) {
  .devlead-toggle {
    padding: 0 7px;
    gap: 0;
  }

  .devlead-toggle-label,
  .devlead-label,
  .devlead-missing {
    display: none;
  }

  .devlead-bar {
    gap: 6px;
    padding: 4px 10px;
  }

  .devlead-meta {
    gap: 6px;
  }
}

.devlead-dock {
  box-sizing: border-box;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-side-clearance, 16px) -
    var(--dsh-composer-dock-inset, 8px) -
    var(--dsh-composer-dock-inset, 8px) -
    var(--dsh-composer-dock-inset, 8px) -
    var(--dsh-composer-dock-inset, 8px)
  );
  max-width: calc(var(--dsh-composer-card-max-width, 952px) - 4 * var(--dsh-composer-dock-inset, 8px));
  margin: 0 auto;
}

/* Menu-surface card: the composer context-stack geometry and elevation triple
   (stroke + soft light) rather than an extra CSS border, which would double the
   hairline and add layout width; the blur needs the surface on a background
   layer, so it is painted by the pseudo-element behind the content. */
.devlead-bar {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  margin: 0 auto;
  padding: 4px 12px;
  overflow: hidden;
  border: 0;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-lg, 12px);
  box-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(0, 0, 0, 0.08));
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 13px;
  line-height: 20px;
  font-family: inherit;
}

.devlead-bar::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background: var(--dsw-specific-menu, Canvas);
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  content: '';
  pointer-events: none;
}

.devlead-glyph {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-label {
  flex: none;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, CanvasText);
  white-space: nowrap;
}

.devlead-meta {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 10px;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.devlead-watched {
  flex: none;
}

.devlead-running {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.devlead-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-dot[data-active="true"] {
  background: var(--dsw-alias-state-success-primary, #2e7d32);
}

.devlead-missing {
  color: var(--dsw-alias-label-secondary, GrayText);
}

/* One stable live region wrapping the hint or the latest-notification chip so
   assistive technology announces a new notification as a content change of an
   existing region, not as a freshly inserted one. */
.devlead-notice {
  display: inline-flex;
  flex: 1 1 auto;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.devlead-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-notification {
  display: inline-flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, GrayText);
  white-space: nowrap;
}

.devlead-notification-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-notification-dot[data-transition="completed"] {
  background: var(--dsw-alias-state-success-primary, #2e7d32);
}

.devlead-notification-dot[data-transition="error"] {
  background: var(--dsw-alias-state-error-primary, #c0392b);
}

.devlead-notification-dot[data-transition="blocked"],
.devlead-notification-dot[data-transition="max-tokens"] {
  background: var(--dsw-alias-state-warn-primary, #a15c00);
}

/* Report dots follow the delivery lane: the action-required kinds (blocked/
   decision/question) share the warning ink — a blocked report is a scheduling
   fact, not a Host failure, so it must not wear the error red. Background
   kinds (progress/fyi) keep the default tertiary dot: a non-urgent update
   reads quieter than a settled outcome. */
.devlead-notification-dot[data-report-kind="blocked"],
.devlead-notification-dot[data-report-kind="decision"],
.devlead-notification-dot[data-report-kind="question"] {
  background: var(--dsw-alias-state-warn-primary, #a15c00);
}

/* Action-required chips wear the warning ink on the kind label so the strip
   reads "the lead must act" at a glance; colour only, never layout. */
.devlead-notification[data-lane="action-required"] .devlead-notification-label {
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

/* Background chips are non-urgent: one uniform opacity step weakens the whole
   chip (dot, who, label, detail) without touching any box, mirroring the
   watched-row mark's quieter-ink idiom. */
.devlead-notification[data-lane="background"] {
  opacity: 0.72;
}

.devlead-notification-who {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary-dimmed, rgba(127, 127, 127, 0.9));
  text-overflow: ellipsis;
}

.devlead-notification-turn,
.devlead-notification-label {
  flex: none;
}

/* Fold-derived question/answer lifecycle suffix ("answered · presented"):
   compact neutral copy — the kind dot and label carry the urgency, the suffix
   only states the lifecycle fact. */
.devlead-notification-status {
  flex: none;
  color: var(--dsw-alias-label-secondary, GrayText);
}

/* A suppressed turn-end wake keeps its transition row; only this marker is
   weakened. Tertiary ink at the detail size reads as an annotation, and the
   marker's title carries the localized explanation of which merge rule hit. */
.devlead-notification-wake {
  flex: none;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-size: 12px;
}

/* A turn failure excerpt keeps the error ink; a report's summary/message
   detail is neutral copy — the kind dot and localized label carry the
   semantics, so progress/fyi/question text must not read as a failure. */
.devlead-notification-error,
.devlead-notification-detail {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
}

.devlead-notification-error {
  color: var(--dsw-alias-label-error, #c0392b);
}

.devlead-notification-detail {
  color: var(--dsw-alias-label-secondary, GrayText);
}

/* Visually hidden but announced: the compact toolbar surface has no inline
   error seat, so its failure text is mirrored into a live region through this
   class (the shipped visually-hidden idiom used by the chat surfaces). */
.devlead-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Sidebar Session-row mark: a non-interactive glyph after the row's time
   label. The seat is inline inside the row's 20px line box, so the icon can
   never change the row height or the title's ellipsis width. */
.devlead-row-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: var(--dsw-alias-label-secondary, GrayText);
}

/* The active lead row gets the same business accent as the toolbar toggle,
   painted as an overlay ring so the 32px row box, padding, and title lane never
   move. Do not color or resize the shell row's border: it has a 3px transparent
   border-inline (paint inset) but no top/bottom border, and an inset box-shadow
   is clipped to the padding box, so either would look thicker/deeper on the
   left/right than on top/bottom. The ::after overlay is positioned against the
   row's border box (negative inline offsets cancel the transparent paint inset)
   and draws one 1px border plus a light outer halo on all four sides at the
   row's own radius. The row owns a stable data-row-key; :has scopes the
   decoration to exactly the active row. The status hook stays mounted while the
   shell hides the resting seat on hover, so the overlay survives hover/focus. */
[data-row-key^="session:"]:has([data-devlead-active-mark="true"]) {
  position: relative;
}

[data-row-key^="session:"]:has([data-devlead-active-mark="true"])::after {
  content: '';
  position: absolute;
  inset: 0 calc(-1 * var(--dsh-sidebar-paint-inset, 3px));
  border: 1px solid var(--dsw-alias-state-business-primary, #4176e6);
  border-radius: inherit;
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.12));
  pointer-events: none;
}

/* A watched row uses a quieter shield than the active lead's mark: secondary
   ink at reduced opacity stays legible in both palettes without competing with
   the active ring. */
.devlead-row-mark-watched {
  color: var(--dsw-alias-label-secondary, GrayText);
  opacity: 0.62;
}

/* Hover-card line explaining the mark; mirrors the shell's hover status rows
   (12px text on a 20px line) so the card keeps one rhythm. */
.devlead-row-hover-active-dot {
  display: inline-block;
  flex: none;
  box-sizing: border-box;
  width: 8px;
  height: 8px;
  border: 1px solid var(--dsw-alias-state-business-primary, #4176e6);
  border-radius: 999px;
}

.devlead-row-hover {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, GrayText);
}

.devlead-row-hover-glyph {
  display: inline-flex;
  flex: none;
  align-items: center;
}

/* Read-only project board: a compact operational overview above a responsive
   project canvas. All colors and elevation come from the Harness theme tokens;
   container queries respond to the actual Sidebar width, not the window. */
.devlead-board-open {
  flex: none;
  width: 28px;
  color: var(--dsw-alias-label-secondary, GrayText);
}

.devlead-board,
.devlead-board * {
  box-sizing: border-box;
}

.devlead-board {
  container: devlead-board / inline-size;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  background: var(--dsw-specific-menu, Canvas);
  color: var(--dsw-alias-label-primary, CanvasText);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
}

.devlead-board-header {
  position: relative;
  flex: none;
  min-width: 0;
  padding: 14px;
  overflow: hidden;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 7%, transparent),
      transparent 68%
    ),
    var(--dsw-specific-menu, Canvas);
}

.devlead-board-title-row,
.devlead-board-title-group,
.devlead-board-live,
.devlead-board-meta,
.devlead-board-card-header,
.devlead-board-card-badges,
.devlead-board-task-heading,
.devlead-board-task-meta,
.devlead-board-progress-heading {
  display: flex;
  min-width: 0;
  align-items: center;
}

.devlead-board-title-row {
  justify-content: space-between;
  gap: 10px;
}

.devlead-board-title-group {
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 8px;
}

.devlead-board-title-group h3,
.devlead-board-card-heading h5,
.devlead-board-group h4,
.devlead-board-placeholder h4,
.devlead-board-error h4,
.devlead-board-blockers h6 {
  min-width: 0;
  margin: 0;
  font: inherit;
  font-weight: 650;
}

.devlead-board-title-group h3 {
  overflow: hidden;
  font-size: 16px;
  line-height: 24px;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-refresh {
  flex: none;
  width: 28px;
  border-radius: var(--dsw-radius-md, 8px);
  color: var(--dsw-alias-label-secondary, GrayText);
  transition:
    color 120ms ease,
    background-color 120ms ease,
    transform 120ms ease;
}

.devlead-board-refresh[aria-busy="true"] > svg {
  animation: devlead-board-spin 1s linear infinite;
}

@keyframes devlead-board-spin {
  to { transform: rotate(360deg); }
}

.devlead-board-live {
  flex-wrap: wrap;
  gap: 3px 6px;
  margin-top: 5px;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-size: 11px;
  line-height: 18px;
}

.devlead-board-live > strong {
  color: var(--dsw-alias-state-success-primary, #2e7d32);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.devlead-board-live[data-auto-refresh="paused"] > strong {
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-board-live[data-auto-refresh="disabled"] > strong {
  color: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-board-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  min-width: 0;
  margin: 12px 0 0;
}

.devlead-board-kpis > div {
  display: flex;
  min-width: 0;
  margin: 0;
  padding: 7px 8px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-md, 8px);
  background: color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 3%, transparent);
  flex-direction: column-reverse;
}

.devlead-board-kpis dt {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-size: 10px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-kpis dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 19px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 23px;
  text-overflow: ellipsis;
}

.devlead-board-kpis > div[data-tone="active"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 8%, transparent);
}

.devlead-board-kpis > div[data-tone="active"] dd {
  color: var(--dsw-alias-state-business-primary, #4176e6);
}

.devlead-board-kpis > div[data-tone="blocked"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 58%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 12%, transparent);
}

.devlead-board-kpis > div[data-tone="blocked"] dd,
.devlead-board-kpis > div[data-tone="blocked"] dt {
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-board-kpis > div[data-tone="done"] dd {
  color: var(--dsw-alias-state-success-primary, #2e7d32);
}

.devlead-board-meta {
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
  margin-top: 9px;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-size: 11px;
  line-height: 16px;
}

.devlead-board-updated {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-revision {
  flex: none;
  margin-left: auto;
  padding: 0 6px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-secondary, GrayText);
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}

.devlead-board-content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.devlead-board-placeholder,
.devlead-board-error {
  display: flex;
  align-items: center;
  max-width: 100%;
  min-height: 180px;
  margin: 8px 0;
  padding: 28px 18px;
  overflow: hidden;
  border: 1px dashed var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-lg, 12px);
  background: color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 2%, transparent);
  color: var(--dsw-alias-label-secondary, GrayText);
  text-align: center;
  flex-direction: column;
  justify-content: center;
}

.devlead-board-state-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  margin-bottom: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 28%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 8%, transparent);
  color: var(--dsw-alias-state-business-primary, #4176e6);
  font-size: 19px;
  font-weight: 600;
  line-height: 1;
}

.devlead-board-placeholder p,
.devlead-board-error p,
.devlead-board-unlisted-body p {
  max-width: 42ch;
  margin: 6px 0 0;
  overflow-wrap: anywhere;
}

.devlead-board-error {
  border-style: solid;
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 60%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 6%, transparent);
  color: var(--dsw-alias-label-error, #c0392b);
}

.devlead-board-error .devlead-board-state-mark {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c0392b) 10%, transparent);
  color: var(--dsw-alias-state-error-primary, #c0392b);
}

.devlead-board-error-detail {
  display: -webkit-box;
  max-width: 100%;
  margin: 12px 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-family: inherit;
  font-size: 12px;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

.devlead-board-blocked-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  margin-bottom: 12px;
  padding: 10px 12px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-state-warn-primary, #a15c00);
  border-radius: var(--dsw-radius-lg, 12px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 12%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 7%, transparent);
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-board-blocked-notice > svg {
  flex: none;
  margin-top: 2px;
}

.devlead-board-blocked-notice > strong {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 650;
}

.devlead-board-group {
  min-width: 0;
  max-width: 100%;
}

.devlead-board-group + .devlead-board-group {
  margin-top: 16px;
}

.devlead-board-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  margin: 0 2px 8px;
  color: var(--dsw-alias-label-secondary, GrayText);
}

.devlead-board-group-header h4 {
  overflow: hidden;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.devlead-board-group[data-board-group="blocked"] > .devlead-board-group-header h4 {
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-board-cards {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
}

.devlead-board-card {
  position: relative;
  min-width: 0;
  max-width: 100%;
  padding: 13px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-specific-menu, Canvas);
  box-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(0, 0, 0, 0.08));
  transition:
    border-color 140ms ease,
    box-shadow 140ms ease,
    transform 140ms ease;
}

.devlead-board-card[data-status="blocked"] {
  border-color: var(--dsw-alias-state-warn-primary, #a15c00);
  background:
    linear-gradient(
      145deg,
      color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 9%, transparent),
      transparent 52%
    ),
    var(--dsw-specific-menu, Canvas);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 15%, transparent),
    var(--dsw-elevation-panel, 0 1px 2px rgba(0, 0, 0, 0.08));
}

.devlead-board-card[data-status="blocked"]::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--dsw-alias-state-warn-primary, #a15c00);
  content: '';
  pointer-events: none;
}

.devlead-board-card-header {
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
}

.devlead-board-card-heading {
  flex: 1 1 130px;
  min-width: 0;
}

.devlead-board-card-heading h5 {
  overflow: hidden;
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 14px;
  line-height: 21px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-project-id {
  display: block;
  margin-top: 1px;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-family: inherit;
  font-size: 10px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-card-badges {
  flex: 0 1 auto;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 5px;
  margin-top: 6px;
  min-width: 0;
  max-width: 100%;
}

.devlead-board-status {
  pointer-events: none;
  font-weight: 600;
}

[data-board-status="blocked"] .devlead-board-status {
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

[data-board-status="active"] .devlead-board-status {
  color: var(--dsw-alias-state-business-primary, #4176e6);
}

[data-board-status="done"] .devlead-board-status {
  color: var(--dsw-alias-state-success-primary, #2e7d32);
}

.devlead-board-workspace {
  display: block;
  max-width: 100%;
  margin-top: 6px;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-family: inherit;
  font-size: 11px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-field {
  min-width: 0;
  margin-top: 10px;
}

.devlead-board-field-label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.035em;
  line-height: 16px;
  text-transform: uppercase;
}

.devlead-board-field-arrow {
  flex: none;
  color: var(--dsw-alias-state-business-primary, #4176e6);
  font-size: 13px;
  line-height: 1;
}

.devlead-board-field p {
  display: -webkit-box;
  min-width: 0;
  margin: 3px 0 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.devlead-board-field-goal {
  margin-top: 8px;
}

.devlead-board-field-goal .devlead-board-field-label,
.devlead-board-field-goal .devlead-board-field-arrow,
.devlead-board-field-goal p {
  color: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-board-field-goal p {
  font-size: 12px;
  -webkit-line-clamp: 1;
}

.devlead-board-field-focus {
  margin-top: 11px;
  padding: 8px 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 14%, transparent);
  border-radius: var(--dsw-radius-md, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 5%, transparent);
}

.devlead-board-field-focus p {
  color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 14px;
  font-weight: 600;
  line-height: 21px;
  -webkit-line-clamp: 3;
}

.devlead-board-field-next p {
  color: var(--dsw-alias-label-secondary, GrayText);
}

.devlead-board-blockers {
  min-width: 0;
  margin-top: 11px;
  padding: 9px 10px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 40%, transparent);
  border-radius: var(--dsw-radius-md, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 10%, transparent);
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-board-blockers h6 {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}

.devlead-board-blockers ul,
.devlead-board-tasks ul {
  min-width: 0;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.devlead-board-blockers li + li {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 24%, transparent);
}

.devlead-board-blockers li > span:first-child {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.devlead-board-blocker-since {
  display: block;
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-size: 11px;
}

.devlead-board-progress {
  min-width: 0;
  margin-top: 12px;
}

.devlead-board-progress-heading {
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 5px;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-size: 11px;
  line-height: 16px;
}

.devlead-board-progress-heading > strong {
  flex: none;
  color: var(--dsw-alias-label-primary, CanvasText);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.devlead-board-progress progress {
  display: block;
  width: 100%;
  max-width: 100%;
  height: 6px;
  overflow: hidden;
  appearance: none;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-state-business-primary, #4176e6);
}

.devlead-board-progress progress::-webkit-progress-bar {
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

.devlead-board-progress progress::-webkit-progress-value {
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary, #4176e6);
}

.devlead-board-progress progress::-moz-progress-bar {
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary, #4176e6);
}

.devlead-board-card[data-status="blocked"] .devlead-board-progress progress {
  color: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-board-card[data-status="blocked"] .devlead-board-progress progress::-webkit-progress-value {
  background: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-board-card[data-status="blocked"] .devlead-board-progress progress::-moz-progress-bar {
  background: var(--dsw-alias-state-warn-primary, #a15c00);
}

.devlead-board-tasks {
  min-width: 0;
  margin-top: 9px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
}

.devlead-board summary {
  min-width: 0;
  max-width: 100%;
  color: var(--dsw-alias-label-secondary, GrayText);
  cursor: pointer;
  font-weight: 500;
  list-style: none;
}

.devlead-board summary::-webkit-details-marker {
  display: none;
}

.devlead-board summary::after {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary, GrayText);
  content: '›';
  font-size: 17px;
  font-weight: 400;
  line-height: 16px;
  transform: rotate(0deg);
  transition: transform 120ms ease;
}

.devlead-board details[open] > summary::after {
  transform: rotate(90deg);
}

.devlead-board-tasks > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px 2px;
  overflow: hidden;
  font-size: 11px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-tasks li {
  min-width: 0;
  padding: 8px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
}

.devlead-board-task-heading {
  align-items: flex-start;
  gap: 8px;
}

.devlead-board-task-title {
  display: -webkit-box;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.devlead-board-task-heading > span:last-child {
  flex: none;
}

.devlead-board-task-meta {
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: 3px;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-size: 11px;
}

.devlead-board-task-meta code {
  min-width: 0;
  overflow: hidden;
  font-family: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-card-footer {
  margin-top: 8px;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-size: 10px;
  line-height: 16px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-muted {
  color: var(--dsw-alias-label-tertiary, GrayText);
}

.devlead-board-secondary {
  min-width: 0;
  max-width: 100%;
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  border-radius: var(--dsw-radius-lg, 12px);
  background: color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 2%, transparent);
}

.devlead-board-secondary > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 9px 11px;
  overflow: hidden;
  transition:
    color 120ms ease,
    background-color 120ms ease;
}

.devlead-board-secondary > summary > h4 {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-size: 12px;
  line-height: 20px;
}

.devlead-board-secondary > summary > h4 > span:first-child,
.devlead-board-unlisted > summary > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-secondary[open] > summary {
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
}

.devlead-board-secondary > .devlead-board-cards {
  padding: 10px;
}

.devlead-board-secondary .devlead-board-card {
  box-shadow: none;
}

.devlead-board-unlisted-body {
  min-width: 0;
  padding: 10px 11px;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, GrayText);
  font-size: 12px;
}

.devlead-board-unlisted-list {
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.devlead-board-unlisted-list li {
  min-width: 0;
  padding: 8px 0;
  overflow: hidden;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
}

.devlead-board-unlisted-list li:last-child {
  border-bottom: 0;
}

.devlead-board-unlisted-list strong,
.devlead-board-unlisted-list code,
.devlead-board-unlisted-list span {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.devlead-board-unlisted-list strong {
  color: var(--dsw-alias-label-primary, CanvasText);
}

.devlead-board-unlisted-list code {
  margin-top: 2px;
  color: var(--dsw-alias-label-tertiary, GrayText);
  font-family: inherit;
  font-size: 11px;
}

.devlead-board-unlisted-list span {
  margin-top: 3px;
}

.devlead-board button:focus-visible,
.devlead-board summary:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: 2px;
}

.devlead-board-card:focus-within {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 60%, transparent);
}

.devlead-board-card:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: 2px;
}

@media (hover: hover) {
  .devlead-board-refresh:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
    color: var(--dsw-alias-label-primary, CanvasText);
    transform: rotate(12deg);
  }

  .devlead-board-card:hover {
    border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 42%, transparent);
    box-shadow: var(--dsw-elevation-panel, 0 1px 2px rgba(0, 0, 0, 0.08));
    transform: translateY(-1px);
  }

  .devlead-board-card[data-status="blocked"]:hover {
    border-color: var(--dsw-alias-state-warn-primary, #a15c00);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a15c00) 12%, transparent);
  }

  .devlead-board summary:hover {
    color: var(--dsw-alias-label-primary, CanvasText);
  }

  .devlead-board-secondary > summary:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  }
}

@container devlead-board (min-width: 620px) {
  .devlead-board-group:not(.devlead-board-secondary) > .devlead-board-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .devlead-board-card {
    padding: 14px;
  }
}

@container devlead-board (max-width: 340px) {
  .devlead-board-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 480px) {
  .devlead-board-header {
    padding: 11px 10px;
  }

  .devlead-board-content {
    padding: 10px;
  }

  .devlead-board-card {
    padding: 11px;
  }

  .devlead-board-live {
    align-items: flex-start;
  }

  .devlead-board-live > span {
    flex: 1 1 150px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .devlead-board *,
  .devlead-board *::before,
  .devlead-board *::after {
    scroll-behavior: auto !important;
    transition: none !important;
    animation: none !important;
  }
}

`

/**
 * Realm-wide key of the stylesheet injection refcount.
 *
 * `Symbol.for` is deliberate: a client-plugin hot update re-evaluates this
 * module, so the page can hold two module instances at once and both must count
 * the same tag. A module-local `Symbol()` would give each instance its own
 * counter, and the old instance's disposer would delete the tag the new one is
 * still using. The state hangs off `globalThis` for the same reason: module
 * bindings die with re-evaluation, the realm's global object does not.
 */
const STYLE_TAG_STATE = Symbol.for('@yankeguo/dsh-client-ui-devlead.style-tag')

/** Realm-wide refcount of the injected stylesheet. */
interface DevLeadStyleTagState {
  /** Live `ensureStyleTag()` calls that have not disposed yet. */
  refs: number
  /** Tag this refcount installed or adopted, while one is known. */
  element: HTMLStyleElement | undefined
}

/** Shape of the `globalThis` record holding {@link DevLeadStyleTagState}. */
type DevLeadStyleTagStore = Record<symbol, DevLeadStyleTagState | undefined>

/**
 * The realm-wide refcount, created on first use.
 * @returns the shared injection state.
 */
function styleTagState(): DevLeadStyleTagState {
  const store = globalThis as unknown as DevLeadStyleTagStore
  const existing = store[STYLE_TAG_STATE]
  if (existing !== undefined) return existing
  const created: DevLeadStyleTagState = { refs: 0, element: undefined }
  store[STYLE_TAG_STATE] = created
  return created
}

/**
 * Resolve the tag the refcount owns: the known connected tag when possible,
 * otherwise a matching tag already in the document (one an older module
 * instance installed), otherwise a fresh one.
 * @param state - shared injection state.
 * @returns the tag to write the current stylesheet into.
 */
function resolveStyleTag(state: DevLeadStyleTagState): HTMLStyleElement {
  const known = state.element
  if (known !== undefined && known.isConnected) return known
  const adopted = document.head.querySelector<HTMLStyleElement>(
    `style[${STYLE_ATTRIBUTE}="${STYLE_KEY}"]`,
  )
  if (adopted !== null) return adopted
  const created = document.createElement('style')
  created.setAttribute(STYLE_ATTRIBUTE, STYLE_KEY)
  document.head.appendChild(created)
  return created
}

/**
 * Reference-count the plugin stylesheet injection.
 *
 * The first live call installs `<style data-plugin-css="devlead">`; later calls
 * reuse (and, after a hot update changed the stylesheet, refresh) that tag and
 * add one reference. Every disposer releases exactly one reference — even when
 * called more than once — and the tag is removed only when the last live
 * reference goes away, so an old module instance's teardown can never delete a
 * tag a newer instance is still using. A matching tag found in the document
 * without shared state tracking (written by an older module version) is adopted
 * and reused instead of duplicated.
 * @returns idempotent disposer releasing one reference to the injected tag.
 */
export function ensureStyleTag(): () => void {
  if (typeof document === 'undefined') return () => {}
  const state = styleTagState()
  const element = resolveStyleTag(state)
  state.element = element
  state.refs += 1
  // A reused or adopted tag may carry text written before a hot update changed
  // the stylesheet; the live tag must match this module instance's CSS.
  if (element.textContent !== styles) element.textContent = styles
  let released = false
  return () => {
    // React effects, plugin `ctx.effect` teardown, and HMR cleanup can race to
    // call one disposer; a double release must not steal another reference.
    if (released) return
    released = true
    state.refs = Math.max(0, state.refs - 1)
    if (state.refs > 0) return
    element.remove()
    if (state.element === element) state.element = undefined
  }
}
