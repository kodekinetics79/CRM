---
name: Wimblo
description: A warm, crisp connected workspace for relationships, giving, and everyday work.
colors:
  accent: "#314568"
  accent-hover: "#243550"
  selected-context: "#ffeadb"
  canvas: "#f5f3f0"
  white: "#fffdfa"
  table-header: "#f0ede8"
  ink: "#1c2942"
  secondary-ink: "#39455b"
  muted: "#586172"
  annotation: "#60697a"
  line: "#dedbd7"
  field-border: "#828b99"
  control-border: "#c1c1c2"
  rail-hover: "#2a3953"
  chart-neutral: "#8d97a6"
  apricot: "#ffb07c"
  apricot-ink: "#7b3f20"
  surface-hover: "#f7f0e9"
  chart-side: "#243550"
  chart-top: "#aebacf"
  rail-text: "#f4eee8"
  rail-muted: "#c4cbd7"
  rail-line: "#48536a"
  danger: "#922e35"
  danger-surface: "#fff0ef"
  danger-border: "#c99194"
  scroll-thumb: "#858d9b"
  scroll-track: "#eeeae5"
typography:
  headline:
    fontFamily: "'IBM Plex Sans', sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-.01em"
  title:
    fontFamily: "'IBM Plex Sans', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-.01em"
  body:
    fontFamily: "'IBM Plex Sans', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-.01em"
  label:
    fontFamily: "'IBM Plex Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: "-.01em"
  button:
    fontFamily: "'IBM Plex Sans', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "-.01em"
  metric:
    fontFamily: "'IBM Plex Sans', sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
rounded:
  control: "6px"
  keyboard: "3px"
  progress: "2px"
spacing:
  field: "4px"
  inline: "8px"
  control-x: "12px"
  section: "16px"
  panel: "22px"
  workspace-y: "24px"
  workspace-x: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  button-danger:
    backgroundColor: "{colors.white}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  nav-item:
    textColor: "{colors.rail-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
  nav-item-active:
    backgroundColor: "{colors.selected-context}"
    textColor: "{colors.ink}"
  status:
    textColor: "{colors.muted}"
  panel:
    backgroundColor: "{colors.white}"
    rounded: "8px"
    padding: "22px"
  table-row-compact:
    backgroundColor: "{colors.white}"
    typography: "{typography.body}"
    padding: "8px 12px"
    height: "40px"
  table-row-default:
    height: "48px"
  table-row-review:
    height: "56px"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.table-header}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
---

# Design System: Wimblo

## Overview

Wimblo’s creative direction is **Gather**: separate pieces become one clear picture. The user approved the sculptural three-piece indigo/apricot logo and requested its warmth, confidence, and crispness across every page. This is an intentional evolution from the prior neutral Kinflect evaluator identity.

The operating workspace keeps familiar record workflows, compact typography, exact financial values, and explicit next actions. The logo is the expressive signature; ordinary tables remain quiet. About is a reading surface inside the same identity, with a larger product statement and the real mark.

The evaluator uses synthetic records and local persistence. Brand polish does not establish district endorsement, live integrations, production certification, or procurement eligibility.

## Colors

**Ownership: Model B.** `src/wimblo.css` owns the runtime color roles. `src/styles.css` and shared components consume CSS variables. This document mirrors accepted role values. The Impeccable sidecar is a documentation adapter, not a second runtime theme.

| Document role | Runtime role | Consumers |
|---|---|---|
| accent / accent-hover | --accent / --accent-hover | Primary action, links, active work tabs, chart selection |
| selected-context | --selected-context | Apricot-tinted selected navigation, first metric context, work overview, scenario/month selection |
| apricot / apricot-ink | --apricot / --apricot-ink | Warm logo/detail, navigation focus, selected icon, readable warm annotation |
| canvas / white / table-header | --canvas / --white / --table-header | Workspace, record surfaces, table headings and contextual inspectors |
| ink / secondary-ink / muted / annotation | Corresponding CSS role | Content and supporting hierarchy |
| line / field-border / control-border | Corresponding CSS role | One-pixel surfaces, fields, controls |
| rail-hover / rail-text / rail-muted / rail-line | Corresponding CSS role | Dark navigation, profile, login context |
| chart-neutral / chart-side / chart-top | Corresponding CSS role | Unselected chart bars and geometrical depth |
| danger / danger-surface / danger-border | Corresponding CSS role | Destructive actions and recovery |
| scroll-thumb / scroll-track | Corresponding CSS role | Global scroll baseline; dark rail has a deliberate adapter |

Deep indigo anchors the product. Apricot is a contextual highlight, not a replacement for readable action text. Warm neutrals distinguish canvas, headings, and records. Status uses explicit text/icons; color alone never communicates business meaning. Chart values remain labeled and inspectable.

## Typography

Self-hosted IBM Plex Sans, weights 400/500/600, owns both operating and display text. Body is 13px with -0.01em tracking and 1.5 line height. Page titles are 28px/600, mobile 26px. Section titles retain 18px/600; About section titles use 20px. About’s introduction is 42px, 34px at intermediate width, 32px on mobile. Login statement is 42px/500, mobile 32px. Avoid making ordinary workflows look like marketing pages.

Numbers use tabular figures. Monetary values stay right aligned, unwrapped, and never truncated. Supporting paragraphs keep a bounded measure, while the About introduction uses a 52ch maximum. Labels remain visible and left aligned.

## Layout

Desktop retains the 220px sticky navigation rail and flexible workspace, with 64px sticky topbar and existing 24px/32px content rhythm. Main navigation scrolls separately while brand and profile remain available. Adding About must not clip workflow destinations.

At 700px and below, use the existing mobile drawer, 56px topbar, and 20px/16px workspace padding. Prioritized mobile records replace desktop tables rather than shrinking every column. Table headers and the first column remain sticky on desktop inside the bounded record scroller. Compact/default/review density remains 40/48/56px.

About uses a two-column introduction and three definition rows on desktop. On mobile, the introduction, relationship definitions, and provider/evaluator sections stack naturally, with no centered operating labels or fixed-height content traps. Long forms retain document scroll ownership.

## Elevation & Depth

Working panels are flat, with one-pixel borders and no shadows. Three warm surface values establish hierarchy. Hover changes the surface, not elevation. Frosting is limited to the sticky topbar to preserve readable context over scrolling content; opaque fallbacks and reduced-transparency support remain available.

The navigation rail echoes Gather’s satin, beveled material: a directional indigo surface, narrow inset edge lighting, and a warm apricot selected row with a small physical bottom edge. The transparent Gather mark is embossed directly into the rail: a narrow upper-left highlight and lower-right silhouette shadow reveal the sculptural edge without a separate tile. These scoped material gradients and shadows belong to navigation; working panels and primary action buttons stay flat. Hover adds surface lighting without moving labels or changing hit boxes.

The 3D Gather raster supplies physical depth in branding. The giving chart retains its explicit flat/depth toggle and labeled exact-value inspector. No animated or decorative glow is added to records.

## Shapes

Controls use 6px corners; record panels and overview/context strips use 8px. About’s introduction uses 12px. The mark has no background tile, border or enclosing rounded square. Navigation uses a 44px transparent sculpture with restrained directional relief; login uses the same transparent material at a larger size. Preserve a four-pixel spacing rhythm and consistently sized Lucide icons. Do not scatter rounded pastel icon tiles across ordinary records.

## Components

`Brand.jsx` owns mark and wordmark composition. `public/brand/wimblo-gather.png` is the common generated raster, used by navigation, login, About, and favicon. Asset provenance is in BRAND-ASSETS.md. Explicit image dimensions reserve geometry.

`ScreenGuide` and `HelpHint` preserve hover/focus/click guidance. `Fields`, `RecordForm`, and `GiftForm` remain the canonical form owners. Native select/date/time popups remain browser-owned; this theme styles their closed controls. `Workspace` owns navigation, editor state, role-sensitive actions, and live-status feedback; About uses that same navigation handler.

Hover color feedback takes 80ms; navigation edge lighting and the selected row’s one-time lighting transition take 120ms. The mobile drawer retains 120ms motion. No bounce or ambient motion is added. Reduced motion disables transitions and animation. Focus, caret, text selection, and all owned scrollbars use palette roles, with forced-colors support.

## Do's and Don'ts

- Use the logo for memorable expression; keep dense work screens calm and predictable.
- Preserve posted monetary contributions, commitments, in-kind support, and receipt reconciliation as separate concepts.
- Make the next action explicit and show supporting records behind totals.
- Keep synthetic/evaluator scope and provider identity honest.
- Do not use gradients on primary action buttons, rainbow metric tiles, color-only statuses, or decorative shadows on working panels. Navigation material depth is the deliberate branding exception.
- Do not turn this brand change into a rewrite of financial, permission, reservation, or contact-preference behavior.
