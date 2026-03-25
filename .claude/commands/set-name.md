---
description: Set your peer display name for this session
arguments:
  - name: name
    description: Your new display name (e.g. frontend-1, api-worker)
    required: true
---

Call the `set_name` MCP tool with the name "$ARGUMENTS". Do not ask for confirmation — just call the tool immediately.

If successful, confirm the name change to the user. If it fails (name taken, invalid characters, etc.), show the error.
