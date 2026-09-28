## v3.0.0 — OpenCode v2 port

Clean v2-only port of `opencode-mempalace-persistence`. Breaks compatibility with opencode v1.x — install v2.8.x on those.

### Breaking changes
- Plugin entry shape: `Plugin.define({ id, setup })` (was `(async ({ client }) => { ... }) satisfies Plugin`)
- Package name: `@rapha/opencode-mempalace-persistence` (was unscoped `opencode-mempalace-persistence` by geco)
- SDK: `@opencode/plugin` v2 (was `@opencode-ai/plugin` v1)

### What's new
- Slash commands `/memory-status` and `/memory-log` registered directly via `ctx.command.transform` — no more external Markdown files to copy
- sessionID is now typed on every hook event (`event.sessionID: Session.ID`)

### What's gone (deferred to v3.1)
- TUI toasts: v2 separates server-side and TUI plugins. The `ctx.ui.toast` API lives on the TUI entry type. Until a paired TUI plugin ships in this package, all "ephemeral" messages route through `~/.mempalace/hook_state/hook.log` (always written, never silent). Pair this with the slash commands for on-demand visibility.

### Install (opencode v2)
```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["@rapha/opencode-mempalace-persistence"]
}
```
