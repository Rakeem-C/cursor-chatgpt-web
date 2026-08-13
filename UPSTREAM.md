# Upstream

This repository is a Cursor-oriented fork of https://github.com/miuuyy/codex-chatgpt-web.

Keep the browser worker, login, Temporary Chat isolation, High → GPT-5.6 Sol slider mapping, and five-tab cap. Cursor-specific code lives under `src/cursor/`.

The original Codex Responses bridge remains available as `cursor-chatgpt-web serve` and `cursor-chatgpt-web mcp-codex`. It is optional. The supported Codex path in this fork is MCP `cursor-mcp` via `install-codex`. Do not set `openai_base_url` / Override OpenAI Base URL for GPT Web.
