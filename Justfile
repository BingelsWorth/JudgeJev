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

# Create the D1 database (local dev)
db-create:
    wrangler d1 create judge-jev

# Run a SQL statement against the local D1 database
# Usage: just db-execute "SELECT * FROM runs;"
db-execute statement:
    wrangler d1 execute judge-jev --command="{{statement}}"

# Run a SQL statement from a file against the local D1 database
# Usage: just db-execute-file path/to/migration.sql
db-execute-file file:
    wrangler d1 execute judge-jev --file="{{file}}"

# Print current wrangler environment info
status:
    wrangler info