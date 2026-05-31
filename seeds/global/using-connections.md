---
name: using-connections
description: Use when a task needs an external tool (GitHub, Notion, etc.) — explains how connections work and what to do when one isn't connected yet.
---

# Using connections

Your external tools come from CONNECTIONS scoped to this channel. The "YOUR CONNECTIONS" block in
your context lists what's connected and what's available but not yet wired.

## When a tool you need is connected
- Just call it. For a connected provider you'll have either typed tools or a single
  `<provider>_call_api(method, path, body)` tool — compose the request from your knowledge of that
  API. Reads are free; writes may require approval.

## When a tool you need is NOT connected
- Tell the person plainly that the provider isn't connected yet and that they (or an operator) need
  to connect it. You CANNOT connect it yourself and you must NEVER accept a token, key, or password
  pasted into the channel — a secret in chat is already compromised.
- Keep API work tight: reach the answer in as few calls as you can; don't fan out over every result.
