# Ava — agent notes

Ava is a voice-first companion. The primary interface is spoken conversation. The visual UI is a calm companion surface, not a dashboard. Prefer less chrome, less copy, and fewer steps.

Stack: **Angular 22** (standalone components, signals) + **Tauri 2** (Rust). Desktop first; Android/iOS are also in the tree.

## Commands

```bash
npm install
npm start                 # Angular only, http://localhost:4200
npm run tauri:dev         # desktop shell around the Angular app
npm run tauri:dev:native  # same, with native-llm
npm test                  # Karma / ChromeHeadless
npm run build
```

Use `npm`, not pnpm, even though a pnpm lockfile exists.

On Windows, Tauri scripts go through `scripts/with-windows-clang.js`. Rust **stable**, not nightly.

## Layout

```
src/app/                 Angular UI
  onboarding/            first-run flow
  settings/              settings sheet
  grok-cli/              desktop Grok CLI / Build overlay
  updates/               in-app update dialog
  confirm-dialog/        in-app confirm / destructive prompts
  services/              shared state and backends (llm, tts, mcp, xai, grok CLI, …)
src-tauri/src/           Rust commands, MCP, voice session, native LLM
docs/                    product / technical specs — do not treat as current implementation
```

New UI that must sit above the app goes next to these feature folders, then is mounted from `app.html`. Shared logic belongs in `src/app/services/`.

## Dialogs and prompts

Never use `window.confirm()`, `alert()`, or `prompt()`. They break the Ava look, steal focus from the Tauri window, and cannot be styled or tested like the rest of the UI.

For any yes/no or destructive confirmation, use `ConfirmDialogService` (`src/app/services/confirm-dialog.ts`) and the already-mounted `<app-confirm-dialog>`.

```ts
const ok = await this.confirm.ask({
  title: 'Reset Ava from scratch?',
  message: 'This deletes downloaded models, settings, gardens, and local databases.',
  confirmLabel: 'Reset cache',
  danger: true,
});
if (!ok) return;
```

- Title is the question. Message is the consequence. Keep both short.
- Destructive actions use `danger: true`.
- Escape and backdrop click cancel. Do not confirm a destructive action on Enter.
- `<app-confirm-dialog>` is already on the root. Do not nest another copy inside settings or a sheet.

The update prompt (`app-update-dialog`) is a separate, specialized dialog. Do not reuse it for confirms.

## UI

- Voice-first: do not add instructional walls, capability grids, or marketing steps to first-run or empty states.
- Match existing overlay language: frosted card, teal/gold wash, 16px radius buttons, no system chrome.
- Verify visual changes in the browser (or the closest substitute) by exercising the flow, not with a single screenshot. Check desktop and a ~390px viewport. Check every surface that reads the state you changed.
- Prefer signals and existing services over new global stores.

## Angular

- Standalone components with `templateUrl` / `styleUrl`.
- Keep templates in `.html` and styles in `.css` next to the component.
- Do not add NgModules.
- Comments explain non-obvious constraints only. Do not narrate the change.

## Rust / Tauri

- Frontend talks to the host with `invoke(...)`.
- New native capability = a `#[tauri::command]` plus a capability entry under `src-tauri/capabilities/` if it needs permissions.
- Guard `invoke` calls with a Tauri check when the same code also runs in the browser (`npm start`).

## Scope

- Change only what the task needs. Do not drive-by refactors or extra docs.
- Do not add README / spec files unless asked.
- `docs/` is product vision. The running code in `src/` and `src-tauri/` is the source of truth.
