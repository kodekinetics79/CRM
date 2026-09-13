---
name: Kinflect
description: A compact enterprise ledger for foundation relationships and saved giving workflows.
colors:
  accent: "#4f46e5"
  accent-hover: "#4338ca"
  selected-context: "#e0e7ff"
  canvas: "#f3f4f6"
  white: "#fff"
  table-header: "#f9fafb"
  ink: "#111827"
  secondary-ink: "#374151"
  muted: "#4b5563"
  annotation: "#6b7280"
  line: "#e5e7eb"
  field-border: "#bdcbd6"
  control-border: "#d1d5db"
  rail-hover: "#1f2937"
  chart-neutral: "#9ca3af"
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
  control: "4px"
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
    textColor: "{colors.control-border}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
  nav-item-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
  status:
    textColor: "{colors.muted}"
  panel:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.control}"
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

# Design System: Kinflect

## Overview

**Creative North Star: "The School Fund Ledger"**

Kinflect is a compact enterprise workspace for inspecting relationships, entering records and comparing saved amounts. IBM Plex Sans, bordered white working surfaces and three light gray surface levels provide the structure. Indigo identifies primary actions and selected states; ordinary records, progress and annotations remain neutral.

The user's phase-three restyle establishes compact flat data planes; the subsequent phase-four request adds frosted navigation and context. Reuse the saved-workflow topology, restrained density and visible context captured here. The product remains a synthetic evaluator pilot: visual polish is not evidence of production certification, official district endorsement, live payment processing or message delivery.

**Key Characteristics:**

- IBM Plex Sans working text with a compact 13px body.
- Three light gray surface levels and explicit borders.
- Indigo primary actions and selected states.
- Sticky navigation, table headers and first-column record context.
- Right-aligned tabular monetary values and active-sort-only indicators.
- Mobile priority fields with native record disclosure.
- Screen guidance and help accessible by hover, focus and touch.

## Colors

The palette is neutral and functional. Frontmatter owns reused color values; the names below explain where they belong.

### Primary

- **Action Indigo** (`accent`, `accent-hover`): primary buttons, current navigation, selected chart months and selected scenario/segment controls. The same indigo provides keyboard focus and invalid-field review outlines.
- **Selected Context** (`selected-context`): text selection against strong dark ink.

### Neutral

- **Working White** (`white`), **Header Gray** (`table-header`) and **Canvas Gray** (`canvas`): white records, softly differentiated table headings and the surrounding workspace/hover context.
- **Ledger Ink** (`ink`): primary text, dark navigation, login-story and tooltip surfaces.
- **Secondary Ink** (`secondary-ink`), **Supporting Gray** (`muted`) and **Annotation Gray** (`annotation`): record actions, explanatory copy, secondary labels and status text.
- **Quiet Divider** (`line`), **Control Boundary** (`control-border`) and **Field Boundary** (`field-border`): one-pixel structural separators and control outlines.
- **Rail Hover** (`rail-hover`): a dark neutral hover state within the rail and the login proof surface.
- **Measured Gray** (`chart-neutral`): unselected monetary bars and quiet chart geometry.

**The Functional Accent Rule.** Reserve indigo for primary actions, selection and visible interaction feedback. Status meaning must remain explicit in text or icons.

## Typography

**Body and Heading Font:** self-hosted IBM Plex Sans with sans-serif fallback. The application imports its available weights (400, 500, 600). Newsreader remains bundled from the prior phase but is not the working-screen heading rule.

Body text is compact; labels and annotations supply secondary context without competing with values. Tabular numerals are enabled globally, and monetary cells additionally request tabular font features and right alignment. Supporting paragraphs retain a maximum measure (75ch); testing instructions use (72ch).

### Hierarchy

- **Page headline:** the frontmatter headline role for working screens.
- **Section title:** the frontmatter title role; section-title components explicitly retain this size on mobile.
- **Body:** the frontmatter body role for records and field values. Navigation shares the body size with an (18px) line height.
- **Labels and controls:** field labels use the label role; primary controls use the button role. Table headers, density controls, table notes and field hints use (11px). Screen guidance and help text use (12px).
- **Metrics:** the standard metric role; the first dashboard metric is emphasized at (36px), contracting to (28px) on mobile. Other mobile metrics remain (24px).
- **Chart comparison:** axis, value and month labels use (11px) in SVG geometry with equal rendered and viewBox widths. The exact-value inspector uses (24px), contracting to (21px) on mobile.
- **Login statement:** IBM Plex Sans (44px), weight (500), contracting to (32px) on mobile. Login form headings retain their authored (33px), then (30px) treatment.

**The Numerical Comparison Rule.** Keep monetary values right-aligned, tabular and unwrapped. Preserve readable chart label sizes rather than shrinking a full-year comparison to fit.

## Layout

Desktop uses a two-track grid: a persistent rail (220px) and a flexible main track. The main shell has automatic width and no left offset. The rail is sticky at the viewport top with a (100dvh) height; its navigation scrolls while identity and profile context remain available. The top bar is sticky and (64px) high. Working content has a maximum width (1700px) and padding (24px 32px).

Panels retain (22px) padding, one-pixel borders and (16px) vertical separation. Detail grids and form grids use (16px) gaps. Dashboard middle columns retain their (1.6:1) ratio until responsive adjustment/stacking; the bottom pair uses (1.65:1). The metric strip emphasizes its first column (1.4:1:1:1). At (1200px) and below, workspace padding becomes (24px), metrics become two columns, the bottom pair stacks and the middle ratio becomes (1.4:1). At (950px) and below, dashboard middle/detail layouts stack and client testing scenarios become a horizontal list.

At (700px) and below, the working grid becomes one column, workspace padding becomes (20px 16px), the top bar is (56px), and forms become one column. The fixed mobile navigation drawer is (256px) wide with a scrim. Closed navigation is inert; opening focuses its first destination and makes the workspace inert. Escape closes the drawer and returns focus to the menu button. These implemented behaviors do not establish a complete focus trap.

Record tables scroll inside a bounded wrapper (620px maximum height), with sticky headers and the first column. Compact is the initial stored density; the density selector offers Compact, Default and Review using the frontmatter row heights. Rows may expand when content requires it. At mobile widths, the common DataTable swaps the desktop table for a record list: primary identity and ranked priority fields stay visible, while additional fields use native `details`/`summary` disclosure. It ranks three columns; specialized screens should rank identity within that set so the visible summary stays within three priority fields. Other specialized tables may retain their own scrolling layout.

Print removes navigation and interactive controls, displays the desktop record representation, expands table scrolling and suppresses help/chart surfaces.

## Elevation & Depth

Surfaces use borders and tonal separation. Box shadows are globally disabled. White records, gray context and a dark rail establish hierarchy without floating panels. The login-story and login-proof use solid dark surfaces. The chart defaults to flat bar fronts on a shared baseline; the explicit depth toggle adds top and side geometry while leaving amount encoding on the fronts. Optional geometry is not a general surface style.

**The Flat Working Surface Rule.** Keep tables, financial values and editors on solid backgrounds with one-pixel boundaries. Frosted navigation and context may provide depth; lift-on-hover and bouncing motion remain inappropriate.

**The Truthful Geometry Rule.** Bar-front height represents saved monetary amount on one shared scale. Optional top and side faces convey geometry only; exact values remain available in the inspector.

**The Frosted Context Rule.** The sticky topbar uses translucent white (88%) and backdrop blur (16px); the dark rail uses dark ink (97%) and blur (18px). Search and upcoming-work panels use near-opaque white (96%) and blur (16px). Opaque fallbacks and reduced-transparency rules preserve legibility. Operations summary uses a restrained white/gray surface wash; data values remain opaque and high contrast. No box shadows or chart filter halos are reintroduced.

## Shapes

Working panels, buttons, inputs, navigation states and tooltips share compact corners from the control radius. Keyboard hints use the smaller keyboard radius; neutral progress tracks use the progress radius. Statuses are plain text or text with an icon rather than colored pills. Keep boundaries explicit and silhouettes rectangular; the circular user avatar is an identity exception.

## Components

### Buttons

Compact and explicit. Primary buttons use indigo with white text; secondary buttons use white, secondary ink and a control boundary. Danger buttons use neutral ink with a stronger annotation-gray boundary and explicit action wording. Button minimum height is (32px); icon controls generally use (36px), with smaller authored chart/help controls. Hover changes color rather than position. Keyboard focus uses an indigo outline (2px) with offset (2px). Disabled controls retain reduced opacity (.55).

### Inputs / Fields

White, bordered controls with compact corners, visible labels and contextual help. Field values use body typography. Fields retain their authored vertical padding; a minimum height is not a guarantee of a fixed rendered height. Invalid fields use an indigo review outline and append “Review this field” to the label. Preserve explanatory errors alongside the visual state.

### Navigation

Dark neutral rail, body-size destinations, compact spacing and indigo current destination. Main rail items are at least (32px) high, increasing to (36px) on mobile. Keep `aria-current`, the menu button's expanded/controlled state and mobile inert behavior aligned with the visible destination.

### Statuses / Containers

Statuses use neutral text, with an icon where implemented, and no colored pill fill. White containers have a one-pixel divider border, compact corners and the panel spacing. Metrics remain one divided strip; client testing uses one scenario list and a detail pane rather than floating tiles.

### Record Tables

Only the actively sorted column shows a direction icon; all sortable headers remain keyboard-operable and expose `aria-sort`. Cell text truncates inside bounded widths with native titles when the rendered value is a string. First-column record actions stay available; supplementary row-open icons appear on row hover/focus and are always available on devices without hover. Use configured priority fields and native disclosure for mobile records.

### Giving Inspector

Flat is the initial chart view. Six months fit the measured plot; the full school year retains a minimum width (620px) and scrolls horizontally when needed. Native month buttons support keyboard/touch inspection, and pointer inspection updates the same exact saved-value context. Explore gifts opens supporting records and is disabled for an empty month. Fees, in-kind support and voided gifts are excluded as stated by the screen.

### Screen Guidance / Help

Each working route includes a short instruction and a help trigger. Field help supplements the visible hint. The trigger exposes expanded state and an accessible description while its tooltip is open. Hover, focus and touch/click open help; leaving or blurring closes it when focus is outside, and Escape closes it. Tooltips use dark ink, light text, a one-pixel dark boundary, compact corners and a bounded width (320px or available viewport). Native expandable testing guidance supplies longer evaluation context.

### Keyboard / Motion

`C` creates on supported routes for writable roles when a text input/editor is not active; the dashboard starts a gift. Command/Ctrl `K` focuses global search. Command/Ctrl `Enter` requests submission of the active workspace form when its submit action is enabled. Keep shortcuts supplementary to visible actions. Hover feedback uses (80ms) easing; the drawer uses a (120ms) slide. Toasts and chart bars have no entrance animation. Reduced-motion preferences disable transitions and animations.

Operations uses action rows with source-record links, chronological work dates and explicit action labels. Volunteer shift rosters expose reserved capacity, availability and waitlists; forms explain the shared foundation scheduling timezone and protect booked schedule fields. Focus moves to the new shift form or selected shift heading. Work tabs support arrow/Home/End navigation.

## Do's and Don'ts

### Do:

- **Do** use IBM Plex Sans and the compact body hierarchy for working screens.
- **Do** separate records with solid surfaces and one-pixel borders.
- **Do** reserve indigo for primary actions, selection and visible interaction feedback.
- **Do** keep money right-aligned and tabular, with exact supporting values available.
- **Do** preserve sticky record context and active-sort-only direction indicators.
- **Do** provide mobile priority fields, native disclosure and hover/focus/touch help.
- **Do** retain explicit pilot scope and saved-workflow distinctions in guidance.

### Don't:

- **Don't** place glass or gradients behind financial tables or editors; keep frosted effects on navigation and contextual layers.
- **Don't** add box shadows, hover lift or bouncing motion.
- **Don't** turn neutral statuses into a new decorative color palette.
- **Don't** shrink full-year chart lettering to force twelve months into a narrow plot.
- **Don't** treat optional chart geometry as another monetary data series.
- **Don't** describe the evaluator pilot as production-certified or imply live delivery/settlement.
