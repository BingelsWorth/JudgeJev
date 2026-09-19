# Judge Jev - local development tasks
# Run `just --list` to see all available recipes.

# Default: show available recipes
default:
    @just --list

# Start the local dev server (wrangler, uses Miniflare under the hood with a dashboard UI)
dev:
    wrangler dev

# Run the test suite
test:
    vitest run

# Watch tests on changes
test-watch:
    vitest

# Type-check the project
typecheck:
    tsc --noEmit

# Build (type-check only in this project)
build:
    tsc --noEmit

# Deploy to Cloudflare
deploy:
    wrangler deploy

# Print current wrangler environment info
status:
    wrangler info