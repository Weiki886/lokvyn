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
