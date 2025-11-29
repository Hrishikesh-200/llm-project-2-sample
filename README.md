---
title: Universal LLM Quiz Solver
emoji: "🤖"
colorFrom: blue
colorTo: green
sdk: nodejs
sdk_version: "18"
app_file: server.js
pinned: false
---

# Universal LLM Quiz Solver

This Space hosts a Node.js server to automatically solve LLM quizzes.

## How it works

- Receives a POST request at `/task` with JSON payload:

```json
{
  "email": "your email",
  "secret": "your secret",
  "url": "https://example.com/quiz-834"
}
