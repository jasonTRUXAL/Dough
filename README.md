# Dough
Pre-Bread Mixing Thinking and Wondering With Code and Things I Don't Know How To Do

---

The assignment and measurement layer for Project Bread, rebuilt from scratch.

Everything is derived from a single `assignment_id` held in a single cookie —
the arm, the factor levels, and the barcode are all pure functions of it, so
there is nothing to keep in sync and nothing to fall out of sync.

- **[docs/architecture.md](docs/architecture.md)** — how it works and why
- **[docs/bread-postmortem.md](docs/bread-postmortem.md)** — what the original
  deployment actually did, read from production, and the requirements derived
  from it

```
npm test     # 28 tests
npm start    # http://127.0.0.1:8080
```

`src/handler.js` is written against the Fetch API signature Contentstack Launch
edge functions use verbatim. It runs today under a disposable DigitalOcean Node
adapter and moves to Launch at end of year with no changes to `src/`.
