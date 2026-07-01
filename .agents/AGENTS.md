# Project Rules & Learnings

## JavaScript & HTML Templates in Workers
- **Template Literal Backslash Escapes**:
  When embedding client-side JavaScript inside server-side template literals (backticks `` ` ``), all backslashes (`\`) must be escaped as double backslashes (`\\`).
  - Example: Use `/[^\\d]/g` instead of `/[^\d]/g`.
  - Example: Use `/^\\d{4}-\\d{2}-\\d{2}$/` instead of `/^\d{4}-\d{2}-\d{2}$/`.
  - Example: Use `\\n` instead of `\n` in string literals.
  Failing to escape will cause the backslashes to be evaluated and dropped during HTML rendering, breaking regular expressions and script parsing on the client side.

## DOM Manipulation & Event Handlers
- **Stale DOM References**:
  Do not rely on variables that store DOM elements globally initialized at page load time. If the DOM gets partially re-rendered or modified, these references might point to detached elements.
  Always retrieve active elements at the time of the event (e.g., inside the `submit` handler) using `document.getElementById` or `form.elements`.
- **Flexible Type Checking**:
  Avoid strict `instanceof HTMLInputElement` checks if not strictly necessary, to prevent bugs where elements under certain runtime contexts (like browser extensions or mocks) fail prototype verification. Use feature detection (e.g., checking if `'value' in element`) or standard fallback strategies.

## Cloudflare Wrangler & D1 Local Development
- **WebSocket Disconnections (`workerd/api/web-socket.c++`)**:
  During local development (`wrangler dev`), warnings or errors like `WebSocket peer disconnected` may appear, leading to database unresponsiveness or unstable hot-reloads.
  - **Resolution**: Stop the `wrangler dev` process (Ctrl+C) and restart it. If D1 states or sessions become corrupt, clear wrangler local state cache (located under the `.wrangler` folder) and re-apply local migrations (`npm run d1:migrate:local`).

