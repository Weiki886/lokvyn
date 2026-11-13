# White and Green Controls

Issue: #21

## Design

Keep the existing desktop workspace structure. White is the primary surface;
forest green identifies selected navigation, primary actions, icons, and focus.
Use quiet neutral borders and a restrained green tint for hover and selection.

The capability, model, and language selectors share an application-rendered
`Select` component. The operating system cannot style a native select popup to
match the workspace, and no existing dependency provides a select primitive.
Search inputs and the message field share `TextInput` and `TextArea` styles.
No additional dependencies or backend changes are needed.

## Directory Refinement

The workspace should feel like a compact local model control desk: scanning and
comparing model information take priority over promotional cards. Keep the white
main surface and forest green emphasis, with neutral sidebar/header bands,
readable secondary text, aligned columns, and consistent Lucide capability icons.
Capability colors distinguish chat, vision, code, and embeddings; they are not
invented vendor logos.

The signature is a model directory with name/description, focus, capability, and
download columns. Replace the equal-weight card grid and repeated introduction
with a compact library summary and filters. Omit secondary columns on narrow
windows, retaining every model's name, description, and labeled action. The
sidebar service summary uses actual installed/running counts, with explicit
loading/unavailable states instead of misleading zeros. Do not invent sizes,
popularity, parameters, or catalog connectivity to fill space.

Refinement plan (maintained code, continuing Issue #21 and PR #22):

1. Add failing application tests for the semantic directory, filtered counts,
   translated headings, disabled downloads, and loaded/unknown service counts.
2. Replace catalog cards in `src/WorkspaceViews.tsx`, update the sidebar summary
   in `src/App.tsx`, and add English/Chinese labels in `src/i18n.ts`.
3. Refine spacing, contrast, typography, and responsive columns in `src/style.css`.
   Reuse existing controls and icons; keep all Ollama actions and preview limits.
4. Run the frontend checks, inspect all seven views in both languages at desktop,
   minimum desktop, and narrow widths, then build and launch the native app.
   Record actual evidence and any native inspection limitation in PR #22.

## Implementation Plan

1. Add failing interaction tests in `src/FormControls.test.tsx` for a controlled
   `Select({ label, value, options, onChange, disabled })`. Cover pointer and
   keyboard selection, typeahead, dismissal, focus, disabled and empty controls,
   and a changing option list. Run `npm test -- src/FormControls.test.tsx`.
2. Implement `src/FormControls.tsx` and `src/form-controls.css`. Keep keyboard
   focus on the combobox and expose its active option through ARIA. Render the
   listbox in a portal, positioned within the viewport with a scrollable list.
   Re-run the component tests.
3. Replace native selectors and text fields in `src/WorkspaceViews.tsx` and
   `src/App.tsx`. Update application tests to select visible options by name.
   Apply white/green tokens and selected states in `src/style.css`.
4. Run formatting, lint, types, tests, and build. Verify both languages and all
   seven views at desktop and narrow sizes, including an open menu and long
   model names. Build and launch the native application for local inspection.

## Interaction Contract

- Click, Enter, Space, or arrow keys open an enabled select.
- Arrows move through options; Home/End select the first/last active option.
- Typing locates an option by its displayed label, including Chinese labels.
- Enter/Space commit; Escape cancels; Tab closes and preserves normal tab order.
- Pointer selection commits once. Outside pointer or focus dismisses the menu.
- Opening highlights the current value. Canceling does not change the value.
- Empty or disabled controls cannot open. Changing options cannot commit a stale
  selection. Long labels wrap in the menu and truncate in the trigger.
- Labels, values, localization persistence, and existing Ollama actions retain
  their current behavior.

## Verification Log

Implementation and verification results are recorded in the pull request.
