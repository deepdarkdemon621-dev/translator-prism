<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Translation operations

Before continuing novel translation or starting any translation worker, read
`AI_TRANSLATION_GUIDE.md`. Starting the worker writes to the production Turso
database, so it always requires explicit user approval for the run window and
stop condition.
