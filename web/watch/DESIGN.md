---
name: Rajan spectator
description: A shared-window control desk in ttballerbot's green and mint identity.
colors:
  bg: "#0b1714"
  surface: "#152b23"
  ink: "#f0fff7"
  muted: "#bddbc9"
  mint: "#88e8b5"
  line: "#385449"
  danger: "#ffb4a8"
typography:
  display:
    fontFamily: "Barlow, Segoe UI, sans-serif"
    fontSize: "clamp(48px, 5.6vw, 80px)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Barlow, Segoe UI, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.05
  body:
    fontFamily: "Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  supporting:
    fontFamily: "Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: "7px"
spacing:
  compact: "8px"
  control-gap: "10px"
  small: "12px"
  body: "16px"
  section: "24px"
  wide: "28px"
components:
  button-primary:
    backgroundColor: "{colors.mint}"
    textColor: "{colors.bg}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.mint}"
    rounded: "{rounded.control}"
    padding: "0"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  select:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 8px 10px 12px"
  preview:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "12px"
---

# Design System: Rajan spectator

## Overview

**Creative North Star: "The shared-window control desk"**

This scoped system records the implementation in `index.html`, `style.css`, and `app.js`. It extends the existing ttballerbot player identity: deep green surfaces, mint actions, pale text, and condensed Barlow headlines. The project-root `DESIGN.md` remains the authority for the Discord player; these rules describe the local spectator companion.

The companion has a quiet, practical control surface with a large window preview and friendly display typography. Familiar browser controls and plain status text carry operational information. It uses flat color, real preview content, and clear boundaries rather than visual activity to imply that work is happening.

**Key Characteristics:**
- Deep green layers with mint actions and focus indicators.
- Condensed Barlow headings with native sans-serif controls and supporting copy.
- A dominant, uncropped window preview beside compact settings on desktop.
- Plain text states and immediate, visible capture controls.

## Colors

The green palette carries forward the player's identity; pale green text keeps the surface calm while peach marks stopping and errors.

### Primary
- **Mint** (`mint`): primary action fill, visible keyboard focus, the empty-preview illustration, and sharing feedback.

### Secondary
- **Soft peach** (`danger`): the stop action's text. Error blocks use a separate warm brown fill and lighter peach text, captured in the sidecar snippets.

### Neutral
- **Deep green** (`bg`): page canvas, field interiors, and dark text on mint buttons.
- **Raised green** (`surface`): the preview well and secondary action backgrounds.
- **Pale mint white** (`ink`): headlines, active control text, command text, and reactions.
- **Quiet sage** (`muted`): descriptions, labels of state, hints, and disclosures.
- **Green divider** (`line`): form outlines and horizontal section boundaries.

**The State Has Words Rule.** Color supports status and errors; visible text names the state or corrective action.

## Typography

**Display Font:** the locally served condensed face is registered in CSS as `Barlow`; use that family name with the source fallback stack.

**Body Font:** Segoe UI with a sans-serif fallback.

The display face supplies the player's compact, conversational personality. Body and control text use the platform's readable sans-serif. Headings balance their wraps; long words and messages can wrap rather than forcing horizontal overflow.

### Hierarchy
- **Display:** the page headline uses the fluid display token, with explicit tablet and mobile overrides described in Layout.
- **Title:** section headings use the title token. The empty-preview heading is larger on desktop (32px) and joins the title size on mobile.
- **Body:** general prose starts at the body token; settings descriptions, status text, and preview instructions use 14px.
- **Label:** form labels use the label token with space above and a smaller gap before their control.
- **Supporting:** hints and provider disclosures use the supporting token. They remain real copy rather than decorative captions.
- **Reaction:** the latest reply uses native sans-serif text at 22px with a 1.4 line height, dropping to 20px on mobile.

**The Two Voices Rule.** Barlow carries the major headings; native sans-serif carries controls, status, and reading copy.

## Layout

The masthead, main content, and footer share a centered container capped at 1440px, including 56px side padding. The introduction places a large headline beside short supporting copy. The working area uses a flexible preview column and a 330px settings column with a 42px gap. Settings sections are divided by thin rules instead of separate cards.

At a viewport width of 1000px or below, side padding becomes 28px, the settings column becomes 290px, the column gap becomes 28px, and the headline is 64px. At 760px or below, side padding becomes 20px, the headline is 54px, and the introduction and working area stack vertically. The preview and its controls remain before pairing and settings. The masthead becomes shorter and the footer stacks.

The preview changes from a 16:9 well to 4:3 on mobile. Video uses `object-fit: contain`, preserving the selected window's proportions. Controls sit immediately below it, with the reaction action pushed to the opposite edge; they can wrap on narrow screens. Pairing keeps the code field and Connect button in one grid row, with the field allowed to shrink.

Spacing is deliberately varied by role: compact control gaps, comfortable body-copy gaps, and larger section separation. Do not normalize every gap into a single interval.

## Elevation & Depth

The interface has no shadows, gradients, backdrop blur, or ornamental motion. Depth comes from the raised green preview well against the deeper canvas, one-pixel field outlines, and horizontal rules. Buttons change background on hover without shifting position. No transition or animation vocabulary is established by this build.

**The Quiet Surface Rule.** Use tonal separation and rules for structure; reserve visible changes for actual interaction or application state.

## Shapes

Controls and error blocks share gently curved corners through the control radius. The larger preview well has a softer silhouette (12px) and clips its content. The live sharing label uses smaller corners (4px). Fields and buttons use one-pixel outlines; page sections use straight, full-width dividers.

## Components

### Buttons

Firm, familiar controls with readable labels. Primary, secondary, and stop buttons have a minimum height of 46px, semibold text, and the shared control radius. Primary buttons use mint with deep green text; secondary actions use raised green with pale text. Stop uses peach text and a warm outline. Their exact hover colors and outlines are in the sidecar.

All focusable elements receive a mint outline (3px) offset from their edge (4px). Disabled buttons use reduced opacity (0.45) and a disabled cursor. The text-only Disconnect action is mint, borderless, and at least 36px tall. On mobile, preview-control buttons use smaller text and narrower horizontal padding.

### Inputs / Fields

Dark, outlined fields use the shared control radius and a minimum height of 46px. Labels remain above the fields. The connection code uses tabular numerals, enlarged text (20px), and expanded tracking (0.12em). Select controls keep native browser selection behavior. Settings remain disabled until pairing succeeds.

### Navigation

The masthead has a compact product link on the left and readable connection status on the right. The spectator suffix is muted. On mobile, the status can occupy up to 42% of the row and wraps with right alignment. This is a single-surface header; no tabs or side navigation are established.

### Window Preview

The preview is the largest bounded surface. Before sharing, it centers an inline outline illustration, a short heading, and instructions. During sharing, the actual video replaces the empty state and a text label identifies the live state. The Choose action is replaced by Stop sharing; React now only enables when current frames and application state permit it.

### Status, Errors, and Reactions

Status text sits beneath the capture controls in a polite live region. Pairing errors appear under the code field; capture and settings errors appear below the preview controls. Error blocks use warm fill, light peach text, comfortable padding, and alert semantics. They expand naturally with long messages. The latest reaction is separated by a top rule and uses larger reading text rather than a speech bubble.

## Do's and Don'ts

### Do:
- **Do** retain the existing green and mint identity when extending this companion.
- **Do** keep controls close to the preview they operate and preserve the uncropped window image.
- **Do** give status, errors, and provider disclosures readable text and honest state changes.
- **Do** preserve visible keyboard focus and native disabled behavior.
- **Do** allow headings, control rows, and long errors to wrap on narrow screens.

### Don't:
- **Don't** replace real preview content with fabricated activity or progress graphics.
- **Don't** add decorative motion or thinking indicators to imply a reaction is guaranteed.
- **Don't** rely on color alone to communicate connection, sharing, or failure states.
- **Don't** apply this companion's browser layout rules to the Discord player's native controls.
