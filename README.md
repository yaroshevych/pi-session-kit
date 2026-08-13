# pi-session-manager

Pi extension for managing session storage:

- Archive old Pi JSONL sessions as maximum-compression `.jsonl.zip` files.
- Restore archived sessions so they appear in `/resume`.
- Import Claude and Codex JSONL sessions into Pi format.

## Install

```bash
pi install npm:pi-session-manager
```

For local development:

```bash
pi -e ./session-manager.ts
```

After installation, run `/reload` and then:

```text
/session-manager
```

## Menu

```text
Session manager
├── Settings...
│   ├── Archive sessions automatically: OFF
│   └── Session age threshold: 7 days
├── Import sessions...
├── Restore sessions (N)
└── Archive old sessions (N)
```

Automatic archiving is disabled by default. When enabled, it runs in the background at session startup, at most once every 24 hours. The default threshold is 7 days and can be changed from Settings. Sessions newer than the threshold are never archived, including during manual archiving. The active session is always skipped.

Archives remain alongside their source session as `<session>.jsonl.zip`. The source JSONL is removed only after compression succeeds. Existing archives are never overwritten. Restoring sessions makes archives from the current project available to `/resume`.

## Supported sources

- Claude: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`

Imports are best-effort and preserve user/assistant text, timestamps, working directory, and source modification time. Tool events and provider-specific metadata are not fully represented. Importing the same source again does not update an existing imported session.

## Requirements

- Pi with `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.
- The `zip` and `unzip` command-line tools available on `PATH`.

## License

MIT
