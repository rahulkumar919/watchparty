# Prisma Migration Deployment Bugfix Design

## Overview

The Render deployment fails with Prisma error P3005 "The database schema is not empty" because the repository lacks migration history while the Neon database contains existing tables from previous deployment attempts. This fix establishes a baseline migration that acknowledges the existing schema and enables Prisma to track future migrations properly. The approach creates a migrations folder with an initial migration matching the current schema.prisma file, then uses Prisma's baseline feature to mark it as applied without re-creating existing tables.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the deployment failure - when Prisma migration deploy runs against a non-empty database without migration history
- **Property (P)**: The desired behavior - Prisma successfully deploys migrations by recognizing the baseline state
- **Preservation**: Existing development workflow and schema management that must remain unchanged
- **Migration History**: The `prisma/migrations` folder containing timestamped SQL migration files that Prisma uses to track applied changes
- **Baseline Migration**: A special migration that acknowledges existing database schema without attempting to recreate it
- **`_prisma_migrations` Table**: Prisma's internal table that tracks which migrations have been applied to a database
- **P3005 Error**: Prisma error code indicating migration deploy was attempted on a non-empty database without migration history

## Bug Details

### Bug Condition

The bug manifests when the Render deployment build command runs `npm run db:migrate:deploy` against a Neon database that contains existing tables (User, Session, Room, RoomParticipant, PlaybackRequest, ChatMessage) but the repository has no `prisma/migrations` folder. Prisma cannot determine which migrations have been applied and refuses to proceed, blocking the deployment.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type DeploymentContext
  OUTPUT: boolean
  
  RETURN input.databaseHasTables == true
         AND input.repositoryHasMigrationsFolder == false
         AND input.command == "prisma migrate deploy"
         AND NOT deploymentSucceeds(input)
END FUNCTION
```

### Examples

- **Render deployment with existing Neon database**: Deployment fails with error "Error: P3005 The database schema for the provided connection string is not empty" - Expected: Deployment succeeds by recognizing baseline schema
- **Fresh Render deployment to empty database**: Would succeed (but this scenario doesn't exist since database already has tables) - Expected: Deployment succeeds by applying all migrations
- **Local development with migrations folder**: Developers run `npx prisma migrate dev` successfully - Expected: Continues to work unchanged
- **Re-deployment after adding new models**: New migrations apply on top of baseline - Expected: Only new migrations are applied, existing tables remain unchanged

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Local development workflow with `npx prisma migrate dev` must continue to work for developers
- The schema.prisma file must continue to serve as the source of truth for database structure
- Existing deployed database tables and data must remain completely intact
- Future migrations for schema changes must apply normally on top of the baseline

**Scope:**
All development operations that do NOT involve the initial Render deployment should be completely unaffected by this fix. This includes:
- Running `npx prisma migrate dev` in local development
- Running `npx prisma generate` to update the Prisma Client
- Running `npx prisma studio` to browse data
- Adding new models or fields to schema.prisma and creating new migrations

## Hypothesized Root Cause

Based on the bug description and Prisma migration behavior, the root causes are:

1. **Missing Migration History**: The repository was created without running `npx prisma migrate dev` to establish initial migration files
   - The schema.prisma file exists and defines the structure
   - Previous deployments somehow created tables (possibly via `prisma db push` or manual SQL)
   - No `prisma/migrations` folder exists to track what was applied

2. **Prisma Safety Check**: Prisma's migration deploy command refuses to run against non-empty databases without migration history
   - This is a safety feature to prevent data loss
   - Prisma cannot determine what state the database is in
   - Without the `_prisma_migrations` table, Prisma has no baseline

3. **Development vs Production Mismatch**: Different tools were used in development vs deployment
   - Development may have used `prisma db push` (which doesn't create migration files)
   - Deployment uses `prisma migrate deploy` (which requires migration files)
   - This mismatch creates the deployment failure

4. **Monorepo Migration**: The backend was extracted from a larger monorepo
   - Migration files may have existed in the original monorepo
   - They were not copied to the backend-only repository
   - The database still reflects the schema from the monorepo

## Correctness Properties

Property 1: Bug Condition - Migration Deployment Success

_For any_ deployment context where the Neon database contains existing schema tables and the repository now has a baseline migration, the fixed deployment process SHALL successfully run `prisma migrate deploy`, recognize the baseline as already applied, and complete the build without the P3005 error.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Development Workflow

_For any_ local development operation (migrate dev, generate, studio) performed after the baseline migration is established, the system SHALL produce exactly the same behavior as before the fix, preserving the development experience and allowing developers to create new migrations normally.

**Validates: Requirements 3.1, 3.2, 3.3**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: Create `apps/server/prisma/migrations/` directory structure

**Migration Structure**: Create timestamped baseline migration

**Specific Changes**:
1. **Create Migration Folder Structure**:
   - Create `apps/server/prisma/migrations/` directory
   - Create `apps/server/prisma/migrations/YYYYMMDDHHMMSS_baseline/` subdirectory with current timestamp
   - Create `apps/server/prisma/migrations/migration_lock.toml` file

2. **Generate Baseline Migration SQL**:
   - Run `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` to generate SQL that creates all tables
   - Save output to `apps/server/prisma/migrations/YYYYMMDDHHMMSS_baseline/migration.sql`
   - This SQL represents the complete schema but won't execute against the existing database

3. **Create Migration Lock File**:
   - Create `apps/server/prisma/migrations/migration_lock.toml` with content:
     ```toml
     provider = "postgresql"
     ```
   - This tells Prisma which database provider the migrations are for

4. **Baseline the Production Database**:
   - After deploying the migration files, run `npx prisma migrate resolve --applied YYYYMMDDHHMMSS_baseline` against the Neon database
   - This marks the baseline migration as already applied in the `_prisma_migrations` table
   - No SQL is executed; Prisma just records that the migration was applied
   - Alternative: Add this command to the Render build command as a one-time operation

5. **Update Build Command (Optional One-Time Step)**:
   - Temporarily modify `render.yaml` buildCommand to include baseline resolution:
     ```
     npm ci && npm run db:generate --workspace=apps/server && npm run build && npx prisma migrate resolve --applied YYYYMMDDHHMMSS_baseline --schema=apps/server/prisma/schema.prisma && npm run db:migrate:deploy --workspace=apps/server
     ```
   - After first successful deployment, can revert to original build command

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, verify the bug exists on the current codebase by attempting deployment simulation, then verify the fix resolves the issue and preserves existing functionality.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm the root cause analysis that missing migration history blocks deployment.

**Test Plan**: Simulate the Render deployment environment locally by attempting to run `prisma migrate deploy` against a test PostgreSQL database that has tables but no migration history. Run these tests on the UNFIXED code to observe the P3005 error.

**Test Cases**:
1. **Empty Migrations Folder Test**: Create fresh PostgreSQL database, manually create schema tables, attempt `prisma migrate deploy` with no migrations folder (will fail with P3005)
2. **Existing Database Test**: Use a copy of the Neon database schema, attempt `prisma migrate deploy` without migrations folder (will fail with P3005)
3. **Migration Diff Test**: Run `prisma migrate diff` to confirm it can generate SQL matching the current schema (will succeed, proving schema.prisma is correct)
4. **Development Workflow Test**: Run `prisma migrate dev` in local environment to confirm development tools work (may succeed or fail depending on local DB state)

**Expected Counterexamples**:
- `prisma migrate deploy` exits with error code and message "Error: P3005 The database schema for the provided connection string is not empty"
- Possible causes: missing migrations folder, no `_prisma_migrations` table, Prisma safety check preventing potential data loss

### Fix Checking

**Goal**: Verify that for all deployment contexts where the bug condition holds (non-empty database, baseline migration now present), the fixed deployment process produces the expected behavior (successful migration deployment).

**Pseudocode:**
```
FOR ALL deploymentContext WHERE isBugCondition(deploymentContext) DO
  result := runDeploymentWithBaseline(deploymentContext)
  ASSERT migrationDeploySucceeds(result)
  ASSERT buildCompletes(result)
  ASSERT serverStarts(result)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all development operations where the bug condition does NOT hold (local development, existing workflows), the fixed codebase produces the same result as the original codebase.

**Pseudocode:**
```
FOR ALL devOperation WHERE NOT isBugCondition(devOperation) DO
  ASSERT executeDevelopmentOperation_original(devOperation) = executeDevelopmentOperation_fixed(devOperation)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across different development scenarios
- It catches edge cases that manual testing might miss (different migration commands, different schema states)
- It provides strong guarantees that development workflow is unchanged for all non-deployment operations

**Test Plan**: Document current behavior of development commands (migrate dev, generate, studio) on UNFIXED code, then write tests verifying this behavior continues after adding baseline migration.

**Test Cases**:
1. **Migrate Dev Preservation**: Run `npx prisma migrate dev` after fix and verify it creates new migrations correctly, doesn't try to recreate baseline
2. **Prisma Generate Preservation**: Run `npx prisma generate` and verify Prisma Client is generated correctly
3. **Prisma Studio Preservation**: Run `npx prisma studio` and verify database browsing works correctly
4. **Schema Change Preservation**: Add a new field to schema.prisma, run `prisma migrate dev`, verify new migration is created and applies correctly

### Unit Tests

- Test that baseline migration SQL matches current schema.prisma using `prisma migrate diff`
- Test that migration_lock.toml has correct provider
- Test that migration folder structure is valid (timestamp format, migration.sql file exists)
- Test that `prisma migrate resolve --applied` command syntax is correct

### Property-Based Tests

- Generate random schema changes and verify new migrations can be created after baseline is established
- Generate random development command sequences and verify they all work correctly with baseline present
- Test that baseline migration never executes SQL against database (only marks as applied)

### Integration Tests

- Test full deployment flow: commit migrations, trigger Render deploy, verify build succeeds, verify server starts
- Test post-deployment migration: add new model, create migration, deploy to Render, verify new migration applies
- Test fresh deployment to empty database: verify baseline migration executes SQL correctly for new databases
- Test that existing data in Neon database remains intact after baseline resolution
