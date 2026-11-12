# Desktop Workspace

Issue: #17. This UI iteration keeps the existing Ollama IPC boundary.

## Design

A compact model workbench: persistent grouped navigation, a shallow top toolbar,
a searchable model table, a right inspector, and a bottom connection strip.
Keep the existing green (`#39735c`), neutral (`#f3f5f2`), and orange (`#ae633d`)
identity. Use system typography, thin borders, quiet surfaces, and Lucide icons.
At narrow widths the navigation collapses to icons and the inspector stacks below
the list. No sample data is substituted for actual installed models.

## Menu and Backend Map

| View | Current UI | Future backend decision |
| --- | --- | --- |
| Discover | Searchable, explicitly non-exhaustive catalog preview | Catalog source, freshness, tags and pagination; `/api/tags` lists installed models only |
| Installed models | Live list, search, inspector, configuration, load/unload | Pull, copy and delete; rename must define copy/delete partial-failure behavior |
| Running models | Live `/api/ps` list and unload controls | Polling and keep-alive controls |
| Downloads | Inactive queue | `/api/pull` progress, cancellation, retry and partial downloads |
| Chat | Model selector and disabled composer | Streaming `/api/chat`, cancellation and history policy |
| API access | Model selector and disabled key controls | Local gateway authentication, secret storage, binding and revocation; no gateway exists yet |
| Settings | Read-only local connection and application information | Endpoint/appearance preferences only after separate design |

The catalog preview is a short static set of model-family examples, not a live
list or a promise that a particular tag or hardware configuration is supported.
Future create/import and embeddings tools can be considered separately; they do
not need empty top-level menus in this iteration.

## Implementation and Verification Plan

1. Complete: add behavior tests for navigation, searching/filtering, persistent
   inspection, preview filtering, and disabled deferred operations; confirm they
   fail against the prior interface.
2. Complete: preserve existing connection/detail/lifecycle IPC and add the
   navigation shell, preview views, inspector, and Lucide icons.
3. Complete: update window dimensions and user-facing scope documentation.
4. In progress: run frontend and desktop checks, inspect desktop and narrow
   rendering, review the final diff, and submit a linked PR for human review.

## Execution Ledger

- Baseline: main at `8211502c9f2e4969803edad1163b8dbfab6ee059` (PR #16).
- New backend implementation and credentials are explicitly deferred.
- Structural graph coverage excluded tests/docs; these were read directly.
- Red-phase evidence: 16 existing tests passed; all 3 new workspace tests failed
  before implementation due to missing navigation and management UI.
- Preview catalog entries are curated examples and are never presented as a live
  or exhaustive Ollama catalog.
