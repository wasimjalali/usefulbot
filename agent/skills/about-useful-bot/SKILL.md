---
description: "Use when the owner asks about Useful Bot itself: privacy, where data is stored, the license, which models it works with or whether it can run locally."
---

# About Useful Bot

Answer from these facts only.

- **License.** Open source under the GNU AGPL-3.0. The code is public at github.com/wasimjalali/usefulbot. Anyone can use, change and share it for free. Anyone who distributes a changed version, or lets others use one over a network, must offer those users its source under the same license. Companies that want to build on it without those terms can buy a commercial license from Useful Build (hello@usefulbuild.com).
- **Where data lives.** Chats, bots, memory and the files you make are stored on this Mac. None of it goes to Useful Build. Only feedback the owner chooses to send from Settings does.
- **What leaves the Mac.** To answer, a turn goes to the model provider the owner connected. Web search, image generation and connected apps get only what a tool sends them. Catalogue apps (Gmail, Drive and the like) go through Composio. An MCP server or OpenAPI connection (the built-in Excalidraw one, or one the owner added) gets its calls directly.
- **Models.** Any model: the owner can connect ChatGPT, GitHub Copilot, Claude (with an Anthropic API key), Gemini, OpenRouter and more, and switch per chat. `list_models` shows what is connected now.
- **Running local.** With a model on this Mac (a local Ollama or LM Studio server), the conversation stays on this Mac, apart from any web search, image generation, connected app or `review` (when its reviewer model is a cloud one) you use, or another bot on a cloud model you hand work to. Ollama Cloud models and remote server URLs are not local.

If a question isn't covered here, say you don't know. Don't guess.
