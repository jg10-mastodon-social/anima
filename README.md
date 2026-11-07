# Ànima

An AI agent that works with your [Solid POD](https://solidproject.org).

> [!WARNING]
> ⚠️ This is still a work in progress! You can learn more about it in my website: [Raising an Agent](https://noeldemartin.com/tasks/raising-an-agent).

## Intro & Demo

![Ànima intro video](https://noeldemartin.com/img/talks/interoperable-local-first-in-the-age-of-ai.png)

- 🎥 [Youtube video](https://www.youtube.com/watch?v=2KFlz9BMrDI&t=928s)
- 📊 [Slides](https://noeldemartin.com/slides/interoperable-local-first-in-the-age-of-ai?slide=21)
- 📝 [Transcription](https://bd.ailishi.ai/blog/interoperable-local-first-ai/en.html#section-7)

## Installation & Usage

Ànima can be used in different ways, depending on your preference:

### SPA (Single Page Application)

This is the live version that you will find in [anima.noeldemartin.com](https://anima.noeldemartin.com).

Here, Ànima runs 100% in the browser, and it'll connect directly with your POD after you log in.

One obvious drawback of this approach is that conversations are coupled to the frontend. If you close the browser before an AI returns its response, it will be lost. Responses that are completed correctly are saved in the POD, so you won't be losing those.

### Desktop App

This is the version you can download from the files attached to [GitHub releases](https://github.com/NoelDeMartin/anima/releases). They are self-contained native binaries that you can run on Windows, macOS, and Linux (I haven't tested most of them, though, so let me know if something doesn't work in your device!).

In this flavor, Ànima comes with a built-in POD you can use to store data in a local folder of your choice. When the service is running, it will be available in port `:1191`; so you can also use it from devices in the same network if your computer is reachable (e.g. `http://192.168.1.19:1191`).

### Service

This version is not easily installable yet, other than cloning this repository and installing the dependencies. Eventually, I'll probably publish a Docker image or an npm package.

Ànima can be served as a traditional server-side application, and it'll return the same frontend used for the SPA and Desktop versions but routing authentication and model interaction through the backend. If the `MANAGED_POD` env variable is set to `true`, it will also run a built-in POD and allow registrations.

## Changes from upstream

This is a personal fork of [NoelDeMartin/anima](https://github.com/NoelDeMartin/anima). The list below is a summary; `git log upstream/main..HEAD` is the authoritative record.

### Model Context Protocol

- The backend can load [MCP](https://modelcontextprotocol.io) servers at boot and expose their tools to chat models. Controlled by `ANIMA_MCP_ENABLED`, `ANIMA_MCP_CONFIG` (see `apps/backend/mcp.example.json`) and `ANIMA_MCP_SERVERS`; the default server is `cairn mcp stdio`.
- Tool definitions are normalized across transports (stdio and HTTP), and MCP tools render as their own chat parts instead of raw JSON.
- MCP is off by default in E2E, eval and test runs unless explicitly enabled, and is only available in backend mode.

### Cairn skills

- A compact catalogue of Cairn skills (name, description, activation, URI) is cached and injected into the system prompt, refreshed at most every five minutes. Skill bodies are never injected; the model calls `load_skill` when it needs one.

### Evals

- Archive a real exchange as a negative case with `vp run evals:archive`, and replay cases against the current prompt with `vp run evals:run`, either locally or live against the POD.
- An LLM judge scores tone, helpfulness, grounding, privacy and task completion, alongside deterministic checks for step budget, finish reason, tool success and non-empty answers.
- Cases and results are gitignored because they contain personal POD data, and the archiver refuses to write inside the repository outside `evals/cases/`.

### Prompt and tools

- System prompt v3 adds strict grounding rules ("I couldn't find X" instead of claiming data is absent), filename assumptions, scope and voice/tone guidance.
- The agent loop has a step budget (`AGENT_MAX_STEPS`) that disables tools on the final step and asks the model to answer with what it has.
- `readFileContents` also reads Markdown and CSV files.

### Authentication and providers

- Solid sessions survive token refreshes, and the external OIDC login flow is fixed.
- Provider configuration no longer leaks between provider types, and OpenCode Go requests send a session header.
- Development and eval runs persist the session to `~/.anima/session.json` (or `~/.anima-dev/session.json`) so CLI tools can reuse it.

### Dependencies

- Floating `next` and `latest` dependencies are pinned to exact versions so the patches in `patches/` keep applying.
