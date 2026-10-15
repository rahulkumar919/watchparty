# Tasks

## 1. Generate baseline migration SQL
**Status**: not_started

Generate the baseline migration SQL that represents the current schema.prisma file.

### Sub-tasks
- [x] 1.1 Navigate to backend repository directory
- [x] 1.2 Run `npx prisma migrate diff --from-empty --to-schema-datamodel apps/server/prisma/schema.prisma --script` to generate SQL
- [x] 1.3 Save the output for the next task
- [x] 1.4 Verify the SQL includes all tables: User, Session, Room, RoomParticipant, PlaybackRequest, ChatMessage

**Depends on**: none

---

## 2. Create migration folder structure
**Status**: not_started

Create the migrations directory structure with a timestamped baseline migration.

### Sub-tasks
- [x] 2.1 Create `apps/server/prisma/migrations/` directory
- [x] 2.2 Generate timestamp in format `YYYYMMDDHHMMSS` (e.g., 20261015182500)
- [x] 2.3 Create `apps/server/prisma/migrations/{timestamp}_baseline/` subdirectory
- [x] 2.4 Save the SQL from task 1 to `apps/server/prisma/migrations/{timestamp}_baseline/migration.sql`
- [x] 2.5 Create `apps/server/prisma/migrations/migration_lock.toml` with content: `provider = "postgresql"`

**Depends on**: 1

---

## 3. Commit and push migration files
**Status**: not_started

Commit the baseline migration to the backend repository and push to GitHub.

### Sub-tasks
- [x] 3.1 Stage the new migration files: `git add apps/server/prisma/migrations/`
- [x] 3.2 Commit with message: "feat: add baseline migration for existing schema"
- [x] 3.3 Push to GitHub: `git push origin main`
- [x] 3.4 Verify commit appears on GitHub

**Depends on**: 2

---

## 4. Update Render build command for baseline resolution
**Status**: not_started

Temporarily update the Render build command to mark the baseline migration as already applied.

### Sub-tasks
- [x] 4.1 Note the migration timestamp from task 2
- [x] 4.2 In Render dashboard, update build command to: `npm ci && npm run db:generate --workspace=apps/server && npm run build && npx prisma migrate resolve --applied {timestamp}_baseline --schema=apps/server/prisma/schema.prisma && npm run db:migrate:deploy --workspace=apps/server`
- [x] 4.3 Trigger manual deploy in Render
- [x] 4.4 Monitor build logs for success

**Depends on**: 3

---

## 5. Verify deployment success
**Status**: not_started

Verify the deployment completes successfully and the server starts.

### Sub-tasks
- [x] 5.1 Check Render build logs show no P3005 error
- [x] 5.2 Verify `prisma migrate resolve` command executes successfully
- [-] 5.3 Verify `prisma migrate deploy` completes without errors
- [-] 5.4 Verify server starts and health endpoint responds
- [x] 5.5 Test the deployed server endpoint

**Depends on**: 4

---

## 6. Restore normal build command
**Status**: not_started

After successful baseline deployment, restore the normal build command without the one-time baseline resolution.

### Sub-tasks
- [~] 6.1 In Render dashboard, update build command back to: `npm ci && npm run db:generate --workspace=apps/server && npm run build && npm run db:migrate:deploy --workspace=apps/server`
- [~] 6.2 Document that future deployments will use normal migration flow
- [~] 6.3 Verify next deployment still works correctly

**Depends on**: 5
