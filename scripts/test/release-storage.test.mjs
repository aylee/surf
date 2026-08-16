import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createReleaseStorage,
  parseTimeTravelBookmark,
  scanRoutineMigrationSql,
  validateD1BackupReceipt
} from "../lib/release-storage.mjs";

const bookmark = "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683";

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "surf-release-storage-"));
  return Promise.resolve()
    .then(() => run(directory))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

function commandContext({
  tableExists = true,
  applied = [],
  exportSql = "create table t (id integer);\n"
} = {}) {
  const calls = [];
  let guards = 0;
  return {
    calls,
    get guards() {
      return guards;
    },
    assertUnchanged() {
      guards += 1;
    },
    runWrangler(args, options) {
      calls.push({ args: [...args], options: { ...options } });
      if (args[0] !== "d1") throw new Error("unexpected command");
      if (args[1] === "time-travel") return JSON.stringify({ bookmark });
      if (args[1] === "export") {
        const outputIndex = args.indexOf("--output");
        writeFileSync(args[outputIndex + 1], exportSql, { mode: 0o644 });
        return "";
      }
      if (args[1] === "execute") {
        const sql = args.at(-1);
        if (sql.includes("sqlite_schema")) {
          return JSON.stringify([
            {
              success: true,
              results: tableExists ? [{ name: "d1_migrations" }] : []
            }
          ]);
        }
        return JSON.stringify([
          { success: true, results: applied.map((name) => ({ name })) }
        ]);
      }
      throw new Error("unexpected D1 command");
    }
  };
}

function migration(directory, name, sql) {
  const path = join(directory, name);
  writeFileSync(path, sql, { mode: 0o600 });
  return path;
}

test("Time Travel bookmark parser accepts Wrangler 4 JSON and rejects drift", () => {
  assert.equal(parseTimeTravelBookmark(JSON.stringify({ bookmark })), bookmark);
  assert.throws(() => parseTimeTravelBookmark("not json"), /malformed JSON/);
  assert.throws(
    () => parseTimeTravelBookmark(JSON.stringify({ bookmark, extra: true })),
    /contain exactly/
  );
  assert.throws(
    () => parseTimeTravelBookmark(JSON.stringify({ bookmark: "short" })),
    /invalid bookmark/
  );
});

test("backup captures bookmark then full remote export and creates exact 0600 receipt", () =>
  withTemporaryDirectory(async (directory) => {
    const context = commandContext();
    const storage = createReleaseStorage({ commandContext: context });
    const destination = join(directory, "surf.sql");
    const receipt = await storage.prepareBackup({
      databaseName: "surf",
      destination
    });

    assert.deepEqual(
      context.calls.map((call) => call.args.slice(0, 3)),
      [
        ["d1", "time-travel", "info"],
        ["d1", "export", "surf"]
      ]
    );
    assert.deepEqual(context.calls[0], {
      args: ["d1", "time-travel", "info", "surf", "--json"],
      options: { capture: true }
    });
    assert.equal(context.calls[1].args.includes("--remote"), true);
    assert.equal(context.calls[1].args.includes("--skip-confirmation"), true);
    assert.equal(context.calls[1].args.includes("--no-schema"), false);
    assert.equal(context.calls[1].args.includes("--no-data"), false);
    assert.match(context.calls[1].args[5], /\.surf\.sql\.partial-/);
    assert.equal(lstatSync(destination).isSymbolicLink(), false);
    assert.equal(lstatSync(destination).mode & 0o7777, 0o600);
    const content = readFileSync(destination);
    assert.equal(receipt.bookmark, bookmark);
    assert.equal(receipt.exportPath, destination);
    assert.equal(receipt.exportBytes, content.length);
    assert.equal(
      receipt.exportSha256,
      createHash("sha256").update(content).digest("hex")
    );
    assert.ok(context.guards >= 4);
    assert.equal(lstatSync(directory).isDirectory(), true);
    assert.deepEqual(
      // The private temporary export directory is removed after linking; the
      // storage-owned receipt remains beside the export for crash recovery.
      readdirSync(directory),
      ["surf.sql", "surf.sql.receipt.json"]
    );
    const durableEvidencePath = `${destination}.receipt.json`;
    assert.equal(lstatSync(durableEvidencePath).isSymbolicLink(), false);
    assert.equal(lstatSync(durableEvidencePath).mode & 0o7777, 0o600);
    const durableEvidence = JSON.parse(readFileSync(durableEvidencePath, "utf8"));
    assert.deepEqual({
      ...durableEvidence,
      exportDevice: "<device>",
      exportInode: "<inode>",
      temporaryPath: "<temporary>"
    }, {
      bookmark,
      databaseName: "surf",
      exportBytes: content.length,
      exportDevice: "<device>",
      exportInode: "<inode>",
      exportPath: destination,
      exportSha256: createHash("sha256").update(content).digest("hex"),
      schemaVersion: 2,
      state: "complete",
      temporaryPath: "<temporary>"
    });
    assert.match(durableEvidence.exportDevice, /^[1-9][0-9]*$/);
    assert.match(durableEvidence.exportInode, /^[1-9][0-9]*$/);
    assert.match(durableEvidence.temporaryPath, /\.surf\.sql\.partial-.*\/export\.sql$/);
  }));

test("backup fsyncs the exact export and containing directory before hashing and receipt", () =>
  withTemporaryDirectory(async (directory) => {
    const descriptorPaths = new Map();
    const events = [];
    const trackingFs = new Proxy(nodeFs, {
      get(target, property) {
        if (property === "openSync") {
          return (path, ...args) => {
            const descriptor = nodeFs.openSync(path, ...args);
            descriptorPaths.set(descriptor, path);
            return descriptor;
          };
        }
        if (property === "fsyncSync") {
          return (descriptor) => {
            events.push(["fsync", descriptorPaths.get(descriptor)]);
            return nodeFs.fsyncSync(descriptor);
          };
        }
        if (property === "createReadStream") {
          return (path, options) => {
            events.push(["hash", path]);
            return nodeFs.createReadStream(path, options);
          };
        }
        if (property === "writeFileSync") {
          return (...args) => {
            if (
              typeof args[1] === "string" &&
              args[1].includes('"state":"complete"')
            ) {
              events.push(["complete-receipt", args[0]]);
            }
            return nodeFs.writeFileSync(...args);
          };
        }
        return Reflect.get(target, property);
      }
    });
    const destination = join(directory, "surf.sql");

    await createReleaseStorage({
      commandContext: commandContext(),
      fs: trackingFs
    }).prepareBackup({ databaseName: "surf", destination });

    const finalHashIndex = events.findIndex(
      ([event, path]) => event === "hash" && path === destination
    );
    const fileSyncIndex = events.findIndex(
      ([event, path]) => event === "fsync" && path === destination
    );
    const directorySyncIndex = events.findIndex(
      ([event, path], index) =>
        event === "fsync" && path === dirname(destination) && index > fileSyncIndex
    );
    const receiptIndex = events.findIndex(
      ([event]) => event === "complete-receipt"
    );

    assert.ok(fileSyncIndex >= 0, "the exact final export descriptor is fsynced");
    assert.ok(
      directorySyncIndex > fileSyncIndex,
      "the containing directory is fsynced after the export"
    );
    assert.ok(
      finalHashIndex > directorySyncIndex,
      "hashing starts only after both durability barriers"
    );
    assert.ok(receiptIndex > finalHashIndex, "the receipt follows the durable hash");
  }));

test("backup rejects empty exports and cleans partial artifacts", () =>
  withTemporaryDirectory(async (directory) => {
    const context = commandContext({ exportSql: "" });
    const destination = join(directory, "empty.sql");
    await assert.rejects(
      createReleaseStorage({ commandContext: context }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /nonempty mode-0600/
    );
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(directory), ["empty.sql.receipt.json"]);
    assert.equal(
      JSON.parse(readFileSync(`${destination}.receipt.json`, "utf8")).state,
      "bookmarked"
    );
  }));

test("backup never overwrites a destination without a receipt", () =>
  withTemporaryDirectory(async (directory) => {
    const destination = join(directory, "existing.sql");
    writeFileSync(destination, "operator data", { mode: 0o600 });
    const context = commandContext();
    await assert.rejects(
      createReleaseStorage({ commandContext: context }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /already exists without a reusable receipt/
    );
    assert.equal(readFileSync(destination, "utf8"), "operator data");
    assert.equal(context.calls.length, 0);
  }));

test("receipt reuse is command-free and exactly revalidates database, path, bytes and hash", () =>
  withTemporaryDirectory(async (directory) => {
    const destination = join(directory, "surf.sql");
    const firstContext = commandContext();
    const receipt = await createReleaseStorage({
      commandContext: firstContext
    }).prepareBackup({ databaseName: "surf", destination });

    const resumeContext = commandContext();
    const reused = await createReleaseStorage({
      commandContext: resumeContext
    }).prepareBackup({ databaseName: "surf", destination, receipt });
    assert.deepEqual(reused, receipt);
    assert.equal(resumeContext.calls.length, 0);

    writeFileSync(destination, "tampered but nonempty", { mode: 0o600 });
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).prepareBackup({
        databaseName: "surf",
        destination,
        receipt
      }),
      /no longer matches/
    );
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).prepareBackup({
        databaseName: "other",
        destination,
        receipt
      }),
      /different database/
    );
  }));

test("storage-owned complete evidence supports command-free resume without a caller receipt", () =>
  withTemporaryDirectory(async (directory) => {
    const destination = join(directory, "surf.sql");
    const initial = await createReleaseStorage({
      commandContext: commandContext()
    }).prepareBackup({ databaseName: "surf", destination });

    const resumeContext = commandContext();
    const resumed = await createReleaseStorage({
      commandContext: resumeContext
    }).prepareBackup({ databaseName: "surf", destination });

    assert.deepEqual(resumed, initial);
    assert.equal(resumeContext.calls.length, 0);
  }));

test("a verified landed export resumes from exact inode evidence without re-export", () =>
  withTemporaryDirectory(async (directory) => {
    const destination = join(directory, "surf.sql");
    let failCompleteEvidence = true;
    const crashFs = new Proxy(nodeFs, {
      get(target, property) {
        if (property !== "writeFileSync") return Reflect.get(target, property);
        return (...args) => {
          if (
            failCompleteEvidence &&
            typeof args[1] === "string" &&
            args[1].includes('"state":"complete"')
          ) {
            failCompleteEvidence = false;
            throw new Error("simulated interruption after export landed");
          }
          return nodeFs.writeFileSync(...args);
        };
      }
    });

    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext(), fs: crashFs }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /simulated interruption/
    );
    assert.equal(lstatSync(destination).mode & 0o7777, 0o600);
    const landingEvidence = JSON.parse(
      readFileSync(`${destination}.receipt.json`, "utf8")
    );
    assert.equal(landingEvidence.state, "landing");
    assert.equal(
      String(lstatSync(landingEvidence.temporaryPath).ino),
      landingEvidence.exportInode
    );

    const resumeContext = commandContext();
    const resumed = await createReleaseStorage({
      commandContext: resumeContext
    }).prepareBackup({ databaseName: "surf", destination });
    assert.equal(resumed.bookmark, bookmark);
    assert.equal(resumeContext.calls.length, 0);
    assert.equal(
      JSON.parse(readFileSync(`${destination}.receipt.json`, "utf8")).state,
      "complete"
    );

    writeFileSync(destination, "attacker-controlled replacement", { mode: 0o600 });
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /exact inode, size, and hash evidence/
    );
    assert.equal(
      JSON.parse(readFileSync(`${destination}.receipt.json`, "utf8")).state,
      "complete"
    );
  }));

test("a crash after landing evidence but before link resumes from the exact temporary inode", () =>
  withTemporaryDirectory(async (directory) => {
    const destination = join(directory, "surf.sql");
    let interrupted = false;
    const crashFs = new Proxy(nodeFs, {
      get(target, property) {
        if (property === "linkSync") {
          return (...args) => {
            if (!interrupted) {
              interrupted = true;
              throw new Error("simulated crash before hard link");
            }
            return nodeFs.linkSync(...args);
          };
        }
        return Reflect.get(target, property);
      }
    });

    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext(), fs: crashFs }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /simulated crash before hard link/
    );
    assert.equal(existsSync(destination), false);
    const landingEvidence = JSON.parse(
      readFileSync(`${destination}.receipt.json`, "utf8")
    );
    assert.equal(landingEvidence.state, "landing");
    assert.equal(
      String(lstatSync(landingEvidence.temporaryPath).ino),
      landingEvidence.exportInode
    );

    const resumeContext = commandContext();
    const resumed = await createReleaseStorage({
      commandContext: resumeContext
    }).prepareBackup({ databaseName: "surf", destination });
    assert.equal(resumed.bookmark, bookmark);
    assert.equal(resumeContext.calls.length, 0);
    assert.equal(readFileSync(destination, "utf8"), "create table t (id integer);\n");
    assert.equal(String(lstatSync(destination).ino), landingEvidence.exportInode);
  }));

test("crafted bookmark evidence cannot promote an arbitrary existing export", () =>
  withTemporaryDirectory(async (directory) => {
    const destination = join(directory, "surf.sql");
    writeFileSync(destination, "arbitrary existing bytes", { mode: 0o600 });
    writeFileSync(
      `${destination}.receipt.json`,
      `${JSON.stringify({
        schemaVersion: 2,
        state: "bookmarked",
        databaseName: "surf",
        bookmark,
        exportPath: destination,
        exportBytes: null,
        exportSha256: null,
        exportDevice: null,
        exportInode: null,
        temporaryPath: null
      })}\n`,
      { mode: 0o600 }
    );

    const context = commandContext();
    await assert.rejects(
      createReleaseStorage({ commandContext: context }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /bookmark-only evidence.*must not be promoted/
    );
    assert.equal(context.calls.length, 0);
    assert.equal(readFileSync(destination, "utf8"), "arbitrary existing bytes");
  }));

test("durable backup evidence rejects loose permissions, symlinks, and export hash drift", () =>
  withTemporaryDirectory(async (directory) => {
    const destination = join(directory, "surf.sql");
    const evidencePath = `${destination}.receipt.json`;
    await createReleaseStorage({
      commandContext: commandContext()
    }).prepareBackup({ databaseName: "surf", destination });

    chmodSync(evidencePath, 0o640);
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /backup evidence must be.*mode-0600/
    );

    chmodSync(evidencePath, 0o600);
    writeFileSync(destination, "tampered export", { mode: 0o600 });
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /no longer matches its exact.*evidence/
    );

    rmSync(evidencePath);
    const evidenceTarget = join(directory, "evidence-target.json");
    writeFileSync(evidenceTarget, "{}\n", { mode: 0o600 });
    symlinkSync(evidenceTarget, evidencePath);
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).prepareBackup({
        databaseName: "surf",
        destination
      }),
      /backup evidence must be.*non-symlink/
    );
  }));

test("receipt reuse rejects loose permissions and symlinks", () =>
  withTemporaryDirectory(async (directory) => {
    const destination = join(directory, "surf.sql");
    const receipt = await createReleaseStorage({
      commandContext: commandContext()
    }).prepareBackup({ databaseName: "surf", destination });
    chmodSync(destination, 0o640);
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).prepareBackup({
        databaseName: "surf",
        destination,
        receipt
      }),
      /mode-0600/
    );
    rmSync(destination);
    const target = join(directory, "target.sql");
    writeFileSync(target, "data", { mode: 0o600 });
    symlinkSync(target, destination);
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).prepareBackup({
        databaseName: "surf",
        destination,
        receipt
      }),
      /not a regular file/
    );
  }));

test("receipt validation is exact and never accepts unjournaled fields", () => {
  const receipt = {
    schemaVersion: 1,
    databaseName: "surf",
    bookmark,
    exportPath: "/private/tmp/surf.sql",
    exportBytes: 5,
    exportSha256: "a".repeat(64)
  };
  assert.deepEqual(validateD1BackupReceipt(receipt), receipt);
  assert.throws(
    () => validateD1BackupReceipt({ ...receipt, token: "do-not-log" }),
    /contain exactly/
  );
  assert.throws(
    () => validateD1BackupReceipt({ ...receipt, exportBytes: 0 }),
    /byte count/
  );
});

test("migration scanner allows additive DDL and ignores comments and literals", () => {
  const result = scanRoutineMigrationSql(`
    -- DROP TABLE forecasts;
    create table if not exists notes (text_value text default 'DELETE FROM spots');
    alter table notes add column created_at text;
    create index if not exists notes_created_at_idx on notes (created_at);
  `);
  assert.equal(result.assurance, "fail-closed-additive-allowlist");
  assert.equal(result.safeForRoutineRelease, true);
  assert.deepEqual(result.findingCodes, []);
});

test("migration scanner fails closed on every statement outside the additive allowlist", () => {
  const cases = [
    ["drop table spots", "statement-not-allowlisted"],
    ["truncate table spots", "statement-not-allowlisted"],
    ["delete from spots", "statement-not-allowlisted"],
    ["update spots set active = 0", "statement-not-allowlisted"],
    ["insert into spots values ('x')", "statement-not-allowlisted"],
    ["alter table spots rename to old_spots", "statement-not-allowlisted"],
    ["pragma foreign_keys = off", "statement-not-allowlisted"],
    ["attach database 'other.db' as other", "statement-not-allowlisted"],
    ["vacuum", "statement-not-allowlisted"],
    ["analyze", "statement-not-allowlisted"],
    ["create view active_spots as select * from spots", "statement-not-allowlisted"],
    ["create trigger mutate after insert on spots begin select 1; end", "statement-not-allowlisted"],
    ["select 1", "statement-not-allowlisted"],
    ["-- comments are not a migration", "no-sql-statements"],
    ["select 'unterminated", "unclosed-sql-token"]
  ];
  for (const [sql, code] of cases) {
    const result = scanRoutineMigrationSql(sql);
    assert.equal(result.safeForRoutineRelease, false, sql);
    assert.equal(result.findingCodes.includes(code), true, sql);
  }
});

test("migration scanner accepts every checked-in migration", () => {
  const migrationDirectory = join(process.cwd(), "packages/db/migrations");
  for (const name of readdirSync(migrationDirectory).filter((entry) =>
    entry.endsWith(".sql")
  )) {
    const result = scanRoutineMigrationSql(
      readFileSync(join(migrationDirectory, name), "utf8")
    );
    assert.equal(result.safeForRoutineRelease, true, name);
    assert.deepEqual(result.findingCodes, [], name);
  }
});

test("pending migration inspection uses only read-only D1 SELECTs", () =>
  withTemporaryDirectory(async (directory) => {
    const paths = [
      migration(directory, "0000_initial.sql", "create table spots (id text);"),
      migration(
        directory,
        "0001_add_active.sql",
        "alter table spots add column active integer;"
      )
    ];
    const context = commandContext({ applied: ["0000_initial.sql"] });
    const result = await createReleaseStorage({
      commandContext: context
    }).inspectPendingMigrations({
      databaseName: "surf",
      migrationPaths: paths
    });
    assert.deepEqual(result.applied.map(({ name }) => name), ["0000_initial.sql"]);
    assert.deepEqual(result.pending.map(({ name }) => name), ["0001_add_active.sql"]);
    assert.equal(result.hasPending, true);
    assert.equal(context.calls.length, 2);
    for (const call of context.calls) {
      assert.deepEqual(call.args.slice(0, 3), ["d1", "execute", "surf"]);
      assert.equal(call.args.includes("--remote"), true);
      assert.equal(call.args.includes("--json"), true);
      assert.match(call.args.at(-1), /^select /i);
      assert.equal(
        /\b(?:insert|update|delete|drop|alter|restore)\b/i.test(call.args.at(-1)),
        false
      );
    }
  }));

test("checked-in generated seed yields a bounded exact read-only reconciliation plan", () => {
  const context = commandContext();
  context.runWrangler = (args, options) => {
    context.calls.push({ args: [...args], options: { ...options } });
    return JSON.stringify([{ success: true, results: [] }]);
  };
  const result = createReleaseStorage({ commandContext: context }).inspectSeedState({
    databaseName: "DB",
    seedPath: join(process.cwd(), "packages/db/seeds/0000_v1_norcal.sql")
  });
  assert.equal(result.matches, false);
  assert.match(result.seedSha256, /^[0-9a-f]{64}$/);
  assert.match(result.semanticSha256, /^[0-9a-f]{64}$/);
  assert.equal(context.calls.length, 3);
  for (const call of context.calls) {
    assert.deepEqual(call.args.slice(0, 3), ["d1", "execute", "DB"]);
    assert.equal(call.args.includes("--remote"), true);
    assert.equal(call.args.includes("--json"), true);
    assert.match(call.args.at(-1), /^select /);
    assert.equal(
      /\b(?:insert|update|delete|drop|alter|restore)\b/i.test(call.args.at(-1)),
      false
    );
  }
});

test("missing migrations table means every local migration is pending", () =>
  withTemporaryDirectory(async (directory) => {
    const path = migration(directory, "0000_initial.sql", "create table spots (id text);");
    const context = commandContext({ tableExists: false });
    const result = await createReleaseStorage({
      commandContext: context
    }).inspectPendingMigrations({
      databaseName: "surf",
      migrationPaths: [path]
    });
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.pending.map(({ name }) => name), ["0000_initial.sql"]);
    assert.equal(context.calls.length, 1);
  }));

test("inspection fails closed on missing applied history, gaps, malformed JSON and symlinks", () =>
  withTemporaryDirectory(async (directory) => {
    const first = migration(directory, "0000_initial.sql", "create table spots (id text);");
    const second = migration(directory, "0001_more.sql", "create table more (id text);");
    await assert.rejects(
      createReleaseStorage({
        commandContext: commandContext({ applied: ["9999_missing.sql"] })
      }).inspectPendingMigrations({
        databaseName: "surf",
        migrationPaths: [first, second]
      }),
      /missing applied D1 migration/
    );
    await assert.rejects(
      createReleaseStorage({
        commandContext: commandContext({ applied: ["0001_more.sql"] })
      }).inspectPendingMigrations({
        databaseName: "surf",
        migrationPaths: [first, second]
      }),
      /ordering gap/
    );
    await assert.rejects(
      createReleaseStorage({
        commandContext: commandContext({
          applied: ["0001_more.sql", "0000_initial.sql"]
        })
      }).inspectPendingMigrations({
        databaseName: "surf",
        migrationPaths: [first, second]
      }),
      /not in local file order/
    );
    const malformed = commandContext();
    malformed.runWrangler = () => "not json";
    await assert.rejects(
      createReleaseStorage({ commandContext: malformed }).inspectPendingMigrations({
        databaseName: "surf",
        migrationPaths: [first]
      }),
      /malformed JSON/
    );
    const linked = join(directory, "0002_linked.sql");
    symlinkSync(first, linked);
    await assert.rejects(
      createReleaseStorage({ commandContext: commandContext() }).inspectPendingMigrations({
        databaseName: "surf",
        migrationPaths: [linked]
      }),
      /non-symlink regular file/
    );
  }));

test("destructive pending migration blocks routine release before any mutation", () =>
  withTemporaryDirectory(async (directory) => {
    const destructive = migration(
      directory,
      "0002_drop.sql",
      "drop table forecast_history;"
    );
    const context = commandContext({ tableExists: false });
    await assert.rejects(
      createReleaseStorage({ commandContext: context }).inspectPendingMigrations({
        databaseName: "surf",
        migrationPaths: [destructive]
      }),
      /Routine release blocked.*statement-not-allowlisted/
    );
    assert.equal(
      context.calls.some((call) => call.args.includes("restore")),
      false
    );
  }));

test("invalid database and migrations-table identifiers never reach Wrangler", async () => {
  const context = commandContext();
  const storage = createReleaseStorage({ commandContext: context });
  await assert.rejects(
    storage.inspectPendingMigrations({
      databaseName: "surf --remote",
      migrationPaths: []
    }),
    /database name is invalid/
  );
  await assert.rejects(
    storage.inspectPendingMigrations({
      databaseName: "surf",
      migrationPaths: [],
      migrationsTable: 'd1_migrations"; drop table spots;--'
    }),
    /safe SQL identifier/
  );
  assert.equal(context.calls.length, 0);
});

test("storage rejects incomplete injected dependencies", () => {
  assert.throws(() => createReleaseStorage(), /requires a command context/);
  assert.throws(
    () =>
      createReleaseStorage({
        commandContext: { runWrangler() {}, assertUnchanged() {} },
        fs: {}
      }),
    /filesystem dependency is incomplete/
  );
});
